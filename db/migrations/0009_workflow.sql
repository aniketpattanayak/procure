-- 0009 Workflow engine: versioned definitions per document type and runtime state. Owner: Workflow agent
-- (contract frozen by Architect, Phase 3). ADR-0011.

CREATE TABLE app.workflow_def (
  id                  uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id           uuid NOT NULL DEFAULT app.current_tenant_id(),
  doc_type_id         uuid NOT NULL REFERENCES app.doc_type(id),
  name                text NOT NULL,
  current_version_id  uuid,
  draft               jsonb,                       -- WorkflowDefinition being edited
  draft_updated_at    timestamptz,
  draft_updated_by    uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  version             int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, doc_type_id)
);
SELECT app.enable_tenant_rls('app.workflow_def');
CREATE TRIGGER workflow_def_touch BEFORE UPDATE ON app.workflow_def FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.workflow_version (
  id            uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id(),
  workflow_id   uuid NOT NULL REFERENCES app.workflow_def(id),
  version       int NOT NULL CHECK (version >= 1),
  definition    jsonb NOT NULL,
  change_note   text,
  published_at  timestamptz NOT NULL DEFAULT now(),
  published_by  uuid,
  UNIQUE (workflow_id, version)
);
SELECT app.enable_tenant_rls('app.workflow_version');
ALTER TABLE app.workflow_def ADD CONSTRAINT workflow_def_current_fk FOREIGN KEY (current_version_id) REFERENCES app.workflow_version(id);

-- One running instance per document at a time (send-back-to-draft cancels it; resubmit starts a new one on the
-- then-current version). Documents finish on the version they started with.
CREATE TABLE app.wf_instance (
  id                   uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id            uuid NOT NULL DEFAULT app.current_tenant_id(),
  document_id          uuid NOT NULL REFERENCES app.document(id),
  workflow_version_id  uuid NOT NULL REFERENCES app.workflow_version(id),
  status               text NOT NULL CHECK (status IN ('running', 'completed', 'cancelled')),
  started_at           timestamptz NOT NULL DEFAULT now(),
  started_by           uuid,
  completed_at         timestamptz,
  cancel_reason        text
);
CREATE UNIQUE INDEX wf_instance_running ON app.wf_instance (tenant_id, document_id) WHERE status = 'running';
SELECT app.enable_tenant_rls('app.wf_instance');

-- Stage state per instance: drives SLA reminders/escalation and the stage timeline.
CREATE TABLE app.wf_stage_state (
  tenant_id         uuid NOT NULL DEFAULT app.current_tenant_id(),
  instance_id       uuid NOT NULL REFERENCES app.wf_instance(id),
  stage_key         text NOT NULL,
  status            text NOT NULL CHECK (status IN ('pending', 'active', 'done', 'skipped', 'disabled')),
  skip_reason       text,                       -- 'condition_false' | 'stage_disabled' | 'no_actor'
  entered_at        timestamptz,
  due_at            timestamptz,
  next_reminder_at  timestamptz,
  reminders_sent    int NOT NULL DEFAULT 0,
  escalated_at      timestamptz,
  completed_at      timestamptz,
  PRIMARY KEY (tenant_id, instance_id, stage_key)
);
CREATE INDEX wf_stage_sla ON app.wf_stage_state (next_reminder_at) WHERE status = 'active' AND next_reminder_at IS NOT NULL;
CREATE INDEX wf_stage_due ON app.wf_stage_state (due_at) WHERE status = 'active' AND escalated_at IS NULL AND due_at IS NOT NULL;
SELECT app.enable_tenant_rls('app.wf_stage_state');

-- Quantity sitting at each stage for each line. A line can be split across stages: e.g. 200 approved at stage 1
-- moved to stage 2 while 50 stays held at stage 1. Sum over stages of (pending + held) = qty still in workflow.
CREATE TABLE app.wf_line_state (
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  instance_id  uuid NOT NULL REFERENCES app.wf_instance(id),
  line_id      uuid NOT NULL REFERENCES app.document_line(id),
  stage_key    text NOT NULL,
  pending_qty  numeric(18,4) NOT NULL DEFAULT 0 CHECK (pending_qty >= 0),
  held_qty     numeric(18,4) NOT NULL DEFAULT 0 CHECK (held_qty >= 0),
  entered_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, instance_id, line_id, stage_key)
);
CREATE INDEX wf_line_state_line ON app.wf_line_state (tenant_id, line_id);
CREATE INDEX wf_line_state_stage ON app.wf_line_state (tenant_id, stage_key) WHERE pending_qty > 0 OR held_qty > 0;
SELECT app.enable_tenant_rls('app.wf_line_state');

-- Every action taken (approve/partial/hold/unhold/reject/send_back/forward/escalate/auto_skip …) with per-line
-- decisions. Append-only. idempotency_key makes retried submissions safe.
CREATE TABLE app.wf_action (
  id               uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id        uuid NOT NULL DEFAULT app.current_tenant_id(),
  instance_id      uuid NOT NULL REFERENCES app.wf_instance(id),
  document_id      uuid NOT NULL REFERENCES app.document(id),
  stage_key        text NOT NULL,
  action           text NOT NULL CHECK (action IN ('submit', 'decide', 'unhold', 'send_back', 'forward', 'escalate',
                     'remind', 'auto_skip', 'auto_approve', 'complete', 'cancel')),
  actor_id         uuid,                         -- NULL for system actions
  on_behalf_of     uuid,                         -- forwarded/escalated assignee acting
  comment          text,
  decisions        jsonb NOT NULL DEFAULT '[]'::jsonb,  -- LineDecision[] as applied (normalised)
  target_stage     text,                         -- send_back / route_to target
  target_user_id   uuid,                         -- forward target
  idempotency_key  text,
  at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX wf_action_idem ON app.wf_action (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX wf_action_doc ON app.wf_action (tenant_id, document_id, at);
SELECT app.enable_tenant_rls('app.wf_action');
REVOKE UPDATE, DELETE ON app.wf_action FROM app_user, platform_user;

-- Explicit assignees beyond the stage's actor rules (forward, escalation). Inbox = rule-based ∪ these.
CREATE TABLE app.wf_assignment (
  id           uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  instance_id  uuid NOT NULL REFERENCES app.wf_instance(id),
  stage_key    text NOT NULL,
  user_id      uuid NOT NULL REFERENCES app.tenant_user(id),
  reason       text NOT NULL CHECK (reason IN ('forward', 'escalation')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  is_active    boolean NOT NULL DEFAULT true
);
CREATE INDEX wf_assignment_user ON app.wf_assignment (tenant_id, user_id) WHERE is_active;
SELECT app.enable_tenant_rls('app.wf_assignment');

GRANT SELECT, INSERT, UPDATE, DELETE ON app.workflow_def, app.wf_instance, app.wf_stage_state, app.wf_line_state, app.wf_assignment TO app_user, platform_user;
GRANT SELECT, INSERT ON app.workflow_version, app.wf_action TO app_user, platform_user;
REVOKE UPDATE, DELETE ON app.workflow_version FROM app_user, platform_user;
