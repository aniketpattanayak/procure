-- 0013 Reports, dashboards, background exports (Phase 7). Owner: Reports agent (contract frozen by Architect). ADR-0015.

CREATE TABLE app.report_def (
  id             uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id(),
  key            text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,60}$'),
  name           text NOT NULL,
  description    text,
  kind           text NOT NULL CHECK (kind IN ('builtin', 'custom')),   -- builtin = shipped ready-made report
  definition     jsonb NOT NULL,                   -- ReportDefinition (packages/schema/src/reports.ts)
  owner_user_id  uuid REFERENCES app.tenant_user(id),
  shared_role_ids uuid[] NOT NULL DEFAULT '{}',
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, key)
);
SELECT app.enable_tenant_rls('app.report_def');
CREATE TRIGGER report_def_touch BEFORE UPDATE ON app.report_def FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.report_schedule (
  id            uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id(),
  report_id     uuid NOT NULL REFERENCES app.report_def(id),
  cron          text NOT NULL,                  -- 5-field cron in the tenant timezone
  format        text NOT NULL DEFAULT 'xlsx' CHECK (format IN ('xlsx', 'csv', 'pdf')),
  recipients    jsonb NOT NULL,                 -- [{ type: 'user', userId } | { type: 'email', address }]
  filters       jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_as_user_id uuid NOT NULL REFERENCES app.tenant_user(id), -- permissions/scope of this user apply
  next_run_at   timestamptz,
  last_run_at   timestamptz,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid
);
CREATE INDEX report_schedule_due ON app.report_schedule (next_run_at) WHERE is_active;
SELECT app.enable_tenant_rls('app.report_schedule');

CREATE TABLE app.dashboard_def (
  id             uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id(),
  name           text NOT NULL,
  layout         jsonb NOT NULL,                  -- DashboardDefinition (widgets + grid positions)
  owner_user_id  uuid REFERENCES app.tenant_user(id),
  shared_role_ids uuid[] NOT NULL DEFAULT '{}',
  is_default_for_role_ids uuid[] NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        int NOT NULL DEFAULT 1
);
SELECT app.enable_tenant_rls('app.dashboard_def');
CREATE TRIGGER dashboard_def_touch BEFORE UPDATE ON app.dashboard_def FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Background exports/report runs; the result is a file (file_object) the user downloads via a signed URL.
CREATE TABLE app.export_job (
  id           uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  kind         text NOT NULL CHECK (kind IN ('report', 'list', 'master', 'import')),
  source       jsonb NOT NULL,                  -- what to export (report id + filters, list scope + query …)
  format       text NOT NULL CHECK (format IN ('xlsx', 'csv', 'pdf')),
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired')),
  row_count    bigint,
  file_id      uuid REFERENCES app.file_object(id),
  error        text,
  requested_by uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  expires_at   timestamptz
);
CREATE INDEX export_job_user ON app.export_job (tenant_id, requested_by, created_at DESC);
SELECT app.enable_tenant_rls('app.export_job');

GRANT SELECT, INSERT, UPDATE, DELETE ON app.report_def, app.report_schedule, app.dashboard_def, app.export_job TO app_user, platform_user;

INSERT INTO platform.permission_def (key, kind, tab_key, label, group_label, requires_feature, requires_setting, sort_order) VALUES
  ('reports',                          'tab',    'reports',           'Reports',                  'Insights', 'reports', NULL, 600),
  ('reports:action.view',              'action', 'reports',           'View reports',             NULL, 'reports', NULL, 1),
  ('reports:action.export',            'action', 'reports',           'Export reports',           NULL, 'reports', NULL, 2),
  ('reports:action.schedule',          'action', 'reports',           'Schedule reports by email',NULL, 'reports', NULL, 3),
  ('reports:action.build',             'action', 'reports',           'Build custom reports',     NULL, 'report_builder', NULL, 4),
  ('reports:action.share',             'action', 'reports',           'Share reports with roles', NULL, 'report_builder', NULL, 5),
  ('dashboards',                       'tab',    'dashboards',        'Dashboards',               'Insights', NULL, NULL, 610),
  ('dashboards:action.view',           'action', 'dashboards',        'View dashboards',          NULL, NULL, NULL, 1),
  ('dashboards:action.edit',           'action', 'dashboards',        'Design dashboards',        NULL, NULL, NULL, 2);
