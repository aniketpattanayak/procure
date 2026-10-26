-- 0008 Documents core: document types, numbering, documents + lines, quantity ledger, line links, comments,
-- attachments, saved views, outbox, audit verification. Owner: Documents agent (contract frozen by Architect, Phase 3).
-- ADR-0010 (generic documents), ADR-0012 (outbox + queues).

-- A document type = header form + optional line form + settings. System types (indent, po, grn, …) are provisioned
-- by their modules in later phases; tenants can create custom types (e.g. "Capex Request") from the UI.
CREATE TABLE app.doc_type (
  id              uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id       uuid NOT NULL DEFAULT app.current_tenant_id(),
  key             text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name            text NOT NULL,                 -- 'Capex Request'
  plural_name     text NOT NULL,
  description     text,
  kind            text NOT NULL CHECK (kind IN ('system', 'custom')),
  module_key      text,                          -- plan feature gating the type (system types); NULL for custom
  header_form_id  uuid NOT NULL REFERENCES app.form_def(id),
  line_form_id    uuid REFERENCES app.form_def(id),   -- NULL = document without lines
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb, -- DocTypeSettings (packages/schema/src/documents.ts)
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  version         int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, key)
);
SELECT app.enable_tenant_rls('app.doc_type');
CREATE TRIGGER doc_type_touch BEFORE UPDATE ON app.doc_type FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Numbering series: most specific active series wins (location node nearest the document's location, else the
-- series with no location). Numbers are assigned at submit, inside the submit transaction (gap-free per series+period).
CREATE TABLE app.numbering_series (
  id                uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id         uuid NOT NULL DEFAULT app.current_tenant_id(),
  doc_type_id       uuid NOT NULL REFERENCES app.doc_type(id),
  name              text NOT NULL,
  location_node_id  uuid REFERENCES app.location_node(id),
  pattern           text NOT NULL CHECK (length(pattern) BETWEEN 1 AND 80),  -- tokens: {LOC} {FY} {FYS} {YYYY} {YY} {MM} {SEQ:n}; literal text allowed
  reset             text NOT NULL DEFAULT 'fy' CHECK (reset IN ('never', 'fy', 'month')),
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  version           int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX numbering_series_scope ON app.numbering_series (tenant_id, doc_type_id, location_node_id) NULLS NOT DISTINCT WHERE is_active;
SELECT app.enable_tenant_rls('app.numbering_series');
CREATE TRIGGER numbering_series_touch BEFORE UPDATE ON app.numbering_series FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.numbering_counter (
  tenant_id  uuid NOT NULL DEFAULT app.current_tenant_id(),
  series_id  uuid NOT NULL REFERENCES app.numbering_series(id),
  period     text NOT NULL,                      -- 'all' | '2026-27' | '2026-10'
  value      bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, series_id, period)
);
SELECT app.enable_tenant_rls('app.numbering_counter');

-- Documents. System fields are real columns (engines read them); everything else is `custom`, validated against
-- the header form version. Status keys: 'draft' | 'waiting_<stage>' | 'on_hold' | 'partially_approved' |
-- 'approved' | 'rejected' | 'cancelled' | 'closed' (+ module-specific keys in later phases, e.g. 'ordered').
CREATE TABLE app.document (
  id                    uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id             uuid NOT NULL DEFAULT app.current_tenant_id(),
  doc_type_id           uuid NOT NULL REFERENCES app.doc_type(id),
  number                text,                                   -- NULL until submitted
  number_series_id      uuid REFERENCES app.numbering_series(id),
  status_key            text NOT NULL DEFAULT 'draft',
  location_node_id      uuid NOT NULL REFERENCES app.location_node(id),
  doc_date              date NOT NULL DEFAULT current_date,
  required_by           date,
  party_id              uuid REFERENCES app.master_record(id),  -- vendor/customer when the type has one
  currency              char(3),
  total_amount          numeric(18,4),
  custom                jsonb NOT NULL DEFAULT '{}'::jsonb,
  form_version_id       uuid NOT NULL REFERENCES app.form_version(id),
  line_form_version_id  uuid REFERENCES app.form_version(id),
  is_locked             boolean NOT NULL DEFAULT false,         -- set by workflow effect lock_editing / submit
  submitted_at          timestamptz,
  submitted_by          uuid,
  closed_at             timestamptz,
  closed_reason         text,
  cancelled_at          timestamptz,
  cancelled_reason      text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid,
  version               int NOT NULL DEFAULT 1,
  is_deleted            boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX document_number ON app.document (tenant_id, doc_type_id, number) WHERE number IS NOT NULL;
CREATE INDEX document_list ON app.document (tenant_id, doc_type_id, status_key, created_at DESC, id) WHERE NOT is_deleted;
CREATE INDEX document_list_all ON app.document (tenant_id, doc_type_id, created_at DESC, id) WHERE NOT is_deleted;
CREATE INDEX document_location ON app.document (tenant_id, location_node_id);
CREATE INDEX document_party ON app.document (tenant_id, party_id) WHERE party_id IS NOT NULL;
SELECT app.enable_tenant_rls('app.document');
CREATE TRIGGER document_touch BEFORE UPDATE ON app.document FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Lines carry doc_type_id + location for item-wise views without joins. Quantities never change after submit
-- except through line_event (the ledger); `qty` is the requested quantity as entered.
CREATE TABLE app.document_line (
  id                uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id         uuid NOT NULL DEFAULT app.current_tenant_id(),
  document_id       uuid NOT NULL REFERENCES app.document(id),
  doc_type_id       uuid NOT NULL REFERENCES app.doc_type(id),
  line_no           int NOT NULL CHECK (line_no >= 1),
  item_id           uuid REFERENCES app.master_record(id),
  uom_id            uuid REFERENCES app.master_record(id),
  qty               numeric(18,4) NOT NULL DEFAULT 0 CHECK (qty >= 0),
  rate              numeric(18,4),
  amount            numeric(18,4),
  required_date     date,
  location_node_id  uuid NOT NULL REFERENCES app.location_node(id),
  status_key        text NOT NULL DEFAULT 'draft',
  custom            jsonb NOT NULL DEFAULT '{}'::jsonb,
  cancelled_reason  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  version           int NOT NULL DEFAULT 1,
  is_deleted        boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX document_line_no ON app.document_line (document_id, line_no) WHERE NOT is_deleted;
CREATE INDEX document_line_doc ON app.document_line (tenant_id, document_id, line_no);
CREATE INDEX document_line_itemwise ON app.document_line (tenant_id, doc_type_id, status_key, created_at DESC, id) WHERE NOT is_deleted;
CREATE INDEX document_line_item ON app.document_line (tenant_id, item_id) WHERE item_id IS NOT NULL;
SELECT app.enable_tenant_rls('app.document_line');
CREATE TRIGGER document_line_touch BEFORE UPDATE ON app.document_line FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- QUANTITY LEDGER (design pack §6). Append-only. Every quantity-changing action on a line is one row.
CREATE TABLE app.line_event (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id(),
  line_id       uuid NOT NULL REFERENCES app.document_line(id),
  document_id   uuid NOT NULL REFERENCES app.document(id),
  event_type    text NOT NULL CHECK (event_type IN (
                  'requested', 'approved', 'held', 'unheld', 'rejected', 'cancelled', 'short_closed', 'over_approved',
                  'selected', 'selection_cancelled', 'ordered', 'order_cancelled', 'received', 'accepted',
                  'rejected_at_receipt', 'issued', 'returned')),
  qty           numeric(18,4) NOT NULL CHECK (qty > 0),
  ref_line_id   uuid REFERENCES app.document_line(id),   -- e.g. the PO line that ordered this indent line
  wf_action_id  uuid,
  stage_key     text,
  reason        text,
  actor_id      uuid,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX line_event_line ON app.line_event (tenant_id, line_id, id);
CREATE INDEX line_event_doc ON app.line_event (tenant_id, document_id, id);
SELECT app.enable_tenant_rls('app.line_event');

-- Derived buckets, updated in the same transaction as each event (QuantityLedger service). A nightly job recomputes
-- from line_event and alerts on drift. Pending figures are computed: see QuantityBuckets in documents.ts.
CREATE TABLE app.line_qty_summary (
  line_id              uuid PRIMARY KEY REFERENCES app.document_line(id),
  tenant_id            uuid NOT NULL DEFAULT app.current_tenant_id(),
  document_id          uuid NOT NULL REFERENCES app.document(id),
  requested            numeric(18,4) NOT NULL DEFAULT 0,
  approved             numeric(18,4) NOT NULL DEFAULT 0,
  held                 numeric(18,4) NOT NULL DEFAULT 0,
  rejected             numeric(18,4) NOT NULL DEFAULT 0,
  cancelled            numeric(18,4) NOT NULL DEFAULT 0,
  short_closed         numeric(18,4) NOT NULL DEFAULT 0,
  over_approved        numeric(18,4) NOT NULL DEFAULT 0,
  selected             numeric(18,4) NOT NULL DEFAULT 0,
  ordered              numeric(18,4) NOT NULL DEFAULT 0,
  received             numeric(18,4) NOT NULL DEFAULT 0,
  accepted             numeric(18,4) NOT NULL DEFAULT 0,
  rejected_at_receipt  numeric(18,4) NOT NULL DEFAULT 0,
  issued               numeric(18,4) NOT NULL DEFAULT 0,
  returned             numeric(18,4) NOT NULL DEFAULT 0,
  last_event_id        bigint,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (requested >= 0 AND approved >= 0 AND held >= 0 AND rejected >= 0 AND cancelled >= 0 AND short_closed >= 0
     AND over_approved >= 0 AND selected >= 0 AND ordered >= 0 AND received >= 0 AND accepted >= 0
     AND rejected_at_receipt >= 0 AND issued >= 0 AND returned >= 0),
  CHECK (approved + rejected + cancelled <= requested + over_approved)
);
CREATE INDEX line_qty_summary_doc ON app.line_qty_summary (tenant_id, document_id);
SELECT app.enable_tenant_rls('app.line_qty_summary');

-- Hand-offs between lines (indent line -> PO line -> GRN line …). Used by Phase 4+.
CREATE TABLE app.line_link (
  id            uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id(),
  from_line_id  uuid NOT NULL REFERENCES app.document_line(id),
  to_line_id    uuid NOT NULL REFERENCES app.document_line(id),
  link_type     text NOT NULL,                 -- 'selected' | 'ordered' | 'received' | 'issued' | 'returned' ...
  qty           numeric(18,4) NOT NULL CHECK (qty > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  is_cancelled  boolean NOT NULL DEFAULT false
);
CREATE INDEX line_link_from ON app.line_link (tenant_id, from_line_id);
CREATE INDEX line_link_to ON app.line_link (tenant_id, to_line_id);
SELECT app.enable_tenant_rls('app.line_link');

-- Collaboration (any entity: 'document' now; 'master_record' etc. later).
CREATE TABLE app.comment (
  id           uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  entity_kind  text NOT NULL,
  entity_id    uuid NOT NULL,
  parent_id    uuid REFERENCES app.comment(id),
  body         text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  mentions     uuid[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid NOT NULL,
  edited_at    timestamptz,
  is_deleted   boolean NOT NULL DEFAULT false
);
CREATE INDEX comment_entity ON app.comment (tenant_id, entity_kind, entity_id, created_at);
SELECT app.enable_tenant_rls('app.comment');

CREATE TABLE app.attachment (
  id           uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  entity_kind  text NOT NULL,
  entity_id    uuid NOT NULL,
  file_id      uuid NOT NULL REFERENCES app.file_object(id),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid NOT NULL,
  is_deleted   boolean NOT NULL DEFAULT false
);
CREATE INDEX attachment_entity ON app.attachment (tenant_id, entity_kind, entity_id, created_at);
SELECT app.enable_tenant_rls('app.attachment');

-- Saved list views (filters, columns, sort) per list scope, personal or shared with roles.
CREATE TABLE app.saved_view (
  id              uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id       uuid NOT NULL DEFAULT app.current_tenant_id(),
  scope_key       text NOT NULL,           -- e.g. 'doc.capex:document', 'doc.capex:item', 'master.item'
  name            text NOT NULL,
  owner_user_id   uuid REFERENCES app.tenant_user(id),   -- NULL = shared
  shared_role_ids uuid[] NOT NULL DEFAULT '{}',
  config          jsonb NOT NULL,          -- SavedViewConfig
  is_default      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 1
);
CREATE INDEX saved_view_scope ON app.saved_view (tenant_id, scope_key);
SELECT app.enable_tenant_rls('app.saved_view');
CREATE TRIGGER saved_view_touch BEFORE UPDATE ON app.saved_view FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Transactional outbox (ADR-0012): written in the business transaction, relayed to BullMQ by the worker.
CREATE TABLE app.outbox_event (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL DEFAULT app.current_tenant_id(),
  event_type      text NOT NULL,           -- 'document.submitted', 'workflow.stage_entered', 'comment.mentioned', ...
  aggregate_kind  text NOT NULL,
  aggregate_id    uuid,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  attempts        int NOT NULL DEFAULT 0,
  last_error      text
);
CREATE INDEX outbox_unpublished ON app.outbox_event (id) WHERE published_at IS NULL;
SELECT app.enable_tenant_rls('app.outbox_event');

-- Nightly audit-chain verification results (platform-wide view for Super Admin; tenants read their own via API).
CREATE TABLE platform.audit_check (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid REFERENCES platform.tenant(id),   -- NULL = platform audit log
  checked_at    timestamptz NOT NULL DEFAULT now(),
  rows_checked  bigint NOT NULL,
  ok            boolean NOT NULL,
  first_bad_id  bigint,
  detail        text
);
CREATE INDEX audit_check_tenant ON platform.audit_check (tenant_id, checked_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON app.doc_type, app.numbering_series, app.numbering_counter, app.document,
  app.document_line, app.line_qty_summary, app.line_link, app.comment, app.attachment, app.saved_view, app.outbox_event
  TO app_user, platform_user;
GRANT SELECT, INSERT ON app.line_event TO app_user, platform_user;
REVOKE UPDATE, DELETE ON app.line_event FROM app_user, platform_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO app_user, platform_user;
GRANT SELECT, INSERT ON platform.audit_check TO platform_user;
GRANT USAGE, SELECT ON SEQUENCE platform.audit_check_id_seq TO platform_user;

-- Outbox relay runs as the platform role across tenants (BYPASSRLS); it never reads business tables.

-- Registry: audit viewer + custom document type designer (platform surfaces).
INSERT INTO platform.permission_def (key, kind, tab_key, label, group_label, requires_feature, requires_setting, sort_order) VALUES
  ('admin.audit',                     'tab',    'admin.audit',      'Audit log',              'Administration', NULL, NULL, 950),
  ('admin.audit:action.view',         'action', 'admin.audit',      'View audit log',         NULL, NULL, NULL, 1),
  ('admin.audit:action.verify',       'action', 'admin.audit',      'Run tamper check',       NULL, NULL, NULL, 2),
  ('config.doc_types',                'tab',    'config.doc_types', 'Document types',         'Configuration', 'form_builder', NULL, 820),
  ('config.doc_types:action.view',    'action', 'config.doc_types', 'View document types',    NULL, 'form_builder', NULL, 1),
  ('config.doc_types:action.add',     'action', 'config.doc_types', 'Create document type',   NULL, 'form_builder', NULL, 2),
  ('config.doc_types:action.edit',    'action', 'config.doc_types', 'Edit document type',     NULL, 'form_builder', NULL, 3),
  ('config.numbering',                'tab',    'config.numbering', 'Numbering series',       'Configuration', NULL, NULL, 830),
  ('config.numbering:action.view',    'action', 'config.numbering', 'View numbering series',  NULL, NULL, NULL, 1),
  ('config.numbering:action.edit',    'action', 'config.numbering', 'Edit numbering series',  NULL, NULL, NULL, 2),
  ('config.workflows',                'tab',    'config.workflows', 'Workflows',              'Configuration', 'workflow_designer', NULL, 840),
  ('config.workflows:action.view',    'action', 'config.workflows', 'View workflows',         NULL, 'workflow_designer', NULL, 1),
  ('config.workflows:action.edit',    'action', 'config.workflows', 'Edit workflow drafts',   NULL, 'workflow_designer', NULL, 2),
  ('config.workflows:action.publish', 'action', 'config.workflows', 'Publish workflows',      NULL, 'workflow_designer', NULL, 3),
  ('approvals',                       'tab',    'approvals',        'Approvals',              'Work', NULL, NULL, 5),
  ('approvals:action.view',           'action', 'approvals',        'See my approvals inbox', NULL, NULL, NULL, 1);
