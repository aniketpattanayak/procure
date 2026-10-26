-- 0012 Notifications, templates, PDF, email, WhatsApp, webhooks (Phase 6). Owner: Integrations agents
-- (contract frozen by Architect). ADR-0014.

-- Provider credentials. scope 'platform' (tenant_id NULL) is the default; a tenant row overrides for that tenant.
-- `secret` is ciphertext (AES-256-GCM with PROVIDER_KEY / KMS in prod); `config` holds non-secret settings.
CREATE TABLE platform.provider_credential (
  id          uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id   uuid REFERENCES platform.tenant(id),
  channel     text NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  provider    text NOT NULL CHECK (provider IN ('ses', 'smtp', 'meta', 'bsp', 'log')),
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,      -- from address, region, phone number id, waba id, host, port …
  secret      text,                                     -- encrypted blob
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX provider_credential_scope ON platform.provider_credential (tenant_id, channel) NULLS NOT DISTINCT WHERE is_active;
CREATE TRIGGER provider_credential_touch BEFORE UPDATE ON platform.provider_credential FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- WhatsApp templates (Meta-approved) managed by Super Admin; tenants may use only those allowed for them.
CREATE TABLE platform.whatsapp_template (
  id           uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  name         text NOT NULL,                  -- Meta template name
  language     text NOT NULL DEFAULT 'en',
  category     text NOT NULL CHECK (category IN ('utility', 'marketing', 'authentication')),
  header_kind  text NOT NULL DEFAULT 'none' CHECK (header_kind IN ('none', 'text', 'document', 'image')),
  body         text NOT NULL,                  -- with {{1}} {{2}} … placeholders
  variables    jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ "index": 1, "label": "PO number" }]
  meta_status  text NOT NULL DEFAULT 'approved' CHECK (meta_status IN ('pending', 'approved', 'rejected', 'paused')),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, language)
);
CREATE TABLE platform.tenant_whatsapp_template (
  tenant_id    uuid NOT NULL REFERENCES platform.tenant(id),
  template_id  uuid NOT NULL REFERENCES platform.whatsapp_template(id),
  approved_by  uuid,
  approved_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, template_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.provider_credential, platform.whatsapp_template, platform.tenant_whatsapp_template TO platform_user;

-- Tenant view of its allowed WhatsApp templates (no access to other tenants' approvals).
CREATE OR REPLACE FUNCTION app.my_whatsapp_templates()
RETURNS TABLE (id uuid, name text, language text, category text, header_kind text, body text, variables jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, platform, app AS $$
  SELECT w.id, w.name, w.language, w.category, w.header_kind, w.body, w.variables
  FROM platform.whatsapp_template w JOIN platform.tenant_whatsapp_template t ON t.template_id = w.id
  WHERE t.tenant_id = app.current_tenant_id() AND w.is_active AND w.meta_status = 'approved'
$$;
REVOKE ALL ON FUNCTION app.my_whatsapp_templates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_whatsapp_templates() TO app_user, platform_user;

-- Message templates: PDF layouts (HTML), email (subject + HTML), WhatsApp (maps a platform template's variables),
-- in-app (title + body). Versioned by row version; sends record the version used.
CREATE TABLE app.message_template (
  id                     uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id              uuid NOT NULL DEFAULT app.current_tenant_id(),
  channel                text NOT NULL CHECK (channel IN ('pdf', 'email', 'whatsapp', 'inapp')),
  doc_type_key           text,                -- NULL = generic (any document / non-document events)
  key                    text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,60}$'),
  name                   text NOT NULL,
  subject                text,                -- email subject / in-app title (Handlebars)
  body                   text NOT NULL,       -- HTML (pdf, email) or text (inapp) with Handlebars placeholders
  whatsapp_template_id   uuid,                -- platform template (channel whatsapp)
  whatsapp_variables     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{ "index": 1, "expr": "{{document.number}}" }]
  pdf_options            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { format: 'A4', landscape: false, margin: {...}, headerHtml, footerHtml }
  is_default             boolean NOT NULL DEFAULT false,
  is_active              boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid,
  version                int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, channel, key)
);
CREATE UNIQUE INDEX message_template_default ON app.message_template (tenant_id, channel, doc_type_key) NULLS NOT DISTINCT WHERE is_default AND is_active;
SELECT app.enable_tenant_rls('app.message_template');
CREATE TRIGGER message_template_touch BEFORE UPDATE ON app.message_template FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Trigger rules: when EVENT on DOC TYPE (and condition) → send TEMPLATE to RECIPIENTS via CHANNEL, auto or manual.
CREATE TABLE app.trigger_rule (
  id                 uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id          uuid NOT NULL DEFAULT app.current_tenant_id(),
  name               text NOT NULL,
  event_type         text NOT NULL,           -- DomainEventType or workflow emit(event)
  doc_type_key       text,                    -- NULL = any
  condition          text,                    -- formula over the document snapshot; NULL = always
  channel            text NOT NULL CHECK (channel IN ('email', 'whatsapp', 'inapp')),
  template_id        uuid NOT NULL REFERENCES app.message_template(id),
  recipients         jsonb NOT NULL,          -- TriggerRecipient[]
  attach_pdf_template_id uuid REFERENCES app.message_template(id),
  mode               text NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'manual')),
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            int NOT NULL DEFAULT 1
);
CREATE INDEX trigger_rule_event ON app.trigger_rule (tenant_id, event_type) WHERE is_active;
SELECT app.enable_tenant_rls('app.trigger_rule');
CREATE TRIGGER trigger_rule_touch BEFORE UPDATE ON app.trigger_rule FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Every send (email / WhatsApp / in-app via trigger) with its lifecycle. idempotency_key prevents double sends.
CREATE TABLE app.outbound_message (
  id                uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id         uuid NOT NULL DEFAULT app.current_tenant_id(),
  channel           text NOT NULL CHECK (channel IN ('email', 'whatsapp', 'inapp')),
  idempotency_key   text NOT NULL,
  trigger_rule_id   uuid REFERENCES app.trigger_rule(id),
  template_id       uuid REFERENCES app.message_template(id),
  template_version  int,
  document_id       uuid REFERENCES app.document(id),
  recipient         text NOT NULL,           -- email address / E.164 phone / user id
  recipient_name    text,
  subject           text,
  body_preview      text,                    -- first 500 chars of rendered body
  attachment_file_ids uuid[] NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'blocked_limit', 'blocked_config', 'cancelled')),
  provider          text,
  provider_message_id text,
  error             text,
  attempts          int NOT NULL DEFAULT 0,
  manual            boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  sent_at           timestamptz,
  delivered_at      timestamptz,
  read_at           timestamptz,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX outbound_message_doc ON app.outbound_message (tenant_id, document_id, created_at DESC);
CREATE INDEX outbound_message_list ON app.outbound_message (tenant_id, created_at DESC, id);
CREATE INDEX outbound_message_provider ON app.outbound_message (provider, provider_message_id) WHERE provider_message_id IS NOT NULL;
SELECT app.enable_tenant_rls('app.outbound_message');

-- Generated PDFs (rendered files live in file_object).
CREATE TABLE app.generated_pdf (
  id           uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  document_id  uuid NOT NULL REFERENCES app.document(id),
  template_id  uuid NOT NULL REFERENCES app.message_template(id),
  template_version int NOT NULL,
  document_version int NOT NULL,
  file_id      uuid REFERENCES app.file_object(id),
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'rendering', 'ready', 'failed')),
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  UNIQUE (tenant_id, document_id, template_id, template_version, document_version)
);
SELECT app.enable_tenant_rls('app.generated_pdf');

-- Outgoing webhooks (plan-limited: webhook_endpoints, feature api_access).
CREATE TABLE app.webhook_endpoint (
  id           uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  url          text NOT NULL CHECK (url ~ '^https://'),
  description  text,
  events       text[] NOT NULL,              -- DomainEventType[]; '*' = all
  secret       text NOT NULL,                -- HMAC key (shown once at creation)
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      int NOT NULL DEFAULT 1
);
SELECT app.enable_tenant_rls('app.webhook_endpoint');
CREATE TRIGGER webhook_endpoint_touch BEFORE UPDATE ON app.webhook_endpoint FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.webhook_delivery (
  id            uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id(),
  endpoint_id   uuid NOT NULL REFERENCES app.webhook_endpoint(id),
  outbox_id     bigint NOT NULL,
  event_type    text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts      int NOT NULL DEFAULT 0,
  response_code int,
  response_body text,                      -- first 1 KB
  next_attempt_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz,
  UNIQUE (endpoint_id, outbox_id)
);
CREATE INDEX webhook_delivery_list ON app.webhook_delivery (tenant_id, created_at DESC);
SELECT app.enable_tenant_rls('app.webhook_delivery');

GRANT SELECT, INSERT, UPDATE, DELETE ON app.message_template, app.trigger_rule, app.outbound_message, app.generated_pdf,
  app.webhook_endpoint, app.webhook_delivery TO app_user, platform_user;

INSERT INTO platform.permission_def (key, kind, tab_key, label, group_label, requires_feature, requires_setting, sort_order) VALUES
  ('config.templates',                 'tab',    'config.templates',  'Templates',                'Configuration', NULL, NULL, 850),
  ('config.templates:action.view',     'action', 'config.templates',  'View templates',           NULL, NULL, NULL, 1),
  ('config.templates:action.edit',     'action', 'config.templates',  'Edit templates',           NULL, NULL, NULL, 2),
  ('config.triggers',                  'tab',    'config.triggers',   'Notification rules',       'Configuration', NULL, NULL, 860),
  ('config.triggers:action.view',      'action', 'config.triggers',   'View rules',               NULL, NULL, NULL, 1),
  ('config.triggers:action.edit',      'action', 'config.triggers',   'Edit rules',               NULL, NULL, NULL, 2),
  ('messages',                         'tab',    'messages',          'Message log',              'Administration', NULL, NULL, 960),
  ('messages:action.view',             'action', 'messages',          'View sent messages',       NULL, NULL, NULL, 1),
  ('messages:action.retry',            'action', 'messages',          'Retry failed messages',    NULL, NULL, NULL, 2),
  ('config.webhooks',                  'tab',    'config.webhooks',   'Webhooks & API',           'Configuration', 'api_access', NULL, 870),
  ('config.webhooks:action.view',      'action', 'config.webhooks',   'View webhooks',            NULL, 'api_access', NULL, 1),
  ('config.webhooks:action.edit',      'action', 'config.webhooks',   'Manage webhooks',          NULL, 'api_access', NULL, 2);
