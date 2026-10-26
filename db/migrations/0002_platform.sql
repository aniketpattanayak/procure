-- 0002 Platform: catalogs, plans, tenants, subscriptions, overrides, usage, platform users, sessions
-- Owner: Platform & tenancy agent (contract frozen by Architect).

-- Feature and limit catalogs are the registry the plan builder reads. Adding a module = inserting a row.
CREATE TABLE platform.feature_catalog (
  key          text PRIMARY KEY,                 -- e.g. 'indent', 'whatsapp', 'form_builder'
  name         text NOT NULL,
  description  text,
  kind         text NOT NULL CHECK (kind IN ('module', 'capability', 'channel')),
  sort_order   int  NOT NULL DEFAULT 0
);

CREATE TABLE platform.limit_catalog (
  key          text PRIMARY KEY,                 -- e.g. 'max_users', 'whatsapp_per_month'
  name         text NOT NULL,
  unit         text NOT NULL,                    -- 'count', 'messages', 'GB', 'calls'
  meter        text NOT NULL CHECK (meter IN ('live_count', 'monthly', 'lifetime')),
  feature_key  text REFERENCES platform.feature_catalog(key),  -- limit only applies when feature is on (nullable = always)
  sort_order   int  NOT NULL DEFAULT 0
);

CREATE TABLE platform.plan (
  id            uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  description   text,
  price         numeric(14,2) NOT NULL DEFAULT 0,
  currency      char(3) NOT NULL DEFAULT 'INR',
  billing_cycle text NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'quarterly', 'yearly')),
  trial_days    int  NOT NULL DEFAULT 0 CHECK (trial_days >= 0),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1
);

CREATE TABLE platform.plan_feature (
  plan_id     uuid NOT NULL REFERENCES platform.plan(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES platform.feature_catalog(key),
  PRIMARY KEY (plan_id, feature_key)
);

CREATE TABLE platform.plan_limit (
  plan_id   uuid NOT NULL REFERENCES platform.plan(id) ON DELETE CASCADE,
  limit_key text NOT NULL REFERENCES platform.limit_catalog(key),
  value     bigint CHECK (value IS NULL OR value >= 0),   -- NULL = unlimited
  PRIMARY KEY (plan_id, limit_key)
);

CREATE TABLE platform.tenant (
  id             uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  code           citext NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,30}$'),  -- typed at login
  name           text NOT NULL,
  legal_name     text,
  logo_url       text,
  tax_ids        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"gstin": "...", "pan": "..."}
  address        jsonb NOT NULL DEFAULT '{}'::jsonb,
  timezone       text NOT NULL DEFAULT 'Asia/Kolkata',
  currency       char(3) NOT NULL DEFAULT 'INR',
  fy_start_month int  NOT NULL DEFAULT 4 CHECK (fy_start_month BETWEEN 1 AND 12),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  status_reason  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        int NOT NULL DEFAULT 1
);

-- One row per plan period. The current subscription is the row with effective_to IS NULL.
-- Upgrade/downgrade = close current row (effective_to) and insert a new one with a future/now effective_from.
CREATE TABLE platform.subscription (
  id             uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id      uuid NOT NULL REFERENCES platform.tenant(id),
  plan_id        uuid NOT NULL REFERENCES platform.plan(id),
  status         text NOT NULL CHECK (status IN ('trial', 'active', 'grace', 'expired', 'suspended')),
  start_date     date NOT NULL,
  renewal_date   date,
  trial_ends_on  date,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to   timestamptz,
  change_reason  text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscription_one_open ON platform.subscription (tenant_id) WHERE effective_to IS NULL;
CREATE INDEX subscription_tenant ON platform.subscription (tenant_id, effective_from DESC);

-- Per-tenant overrides. Effective value = override if present, else plan value.
CREATE TABLE platform.tenant_override (
  tenant_id  uuid NOT NULL REFERENCES platform.tenant(id),
  kind       text NOT NULL CHECK (kind IN ('feature', 'limit')),
  key        text NOT NULL,
  value      jsonb NOT NULL,    -- feature: true/false ; limit: number or null (unlimited)
  reason     text,
  set_by     uuid,
  set_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, key)
);

CREATE TABLE platform.tenant_override_history (
  id         uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id  uuid NOT NULL REFERENCES platform.tenant(id),
  kind       text NOT NULL,
  key        text NOT NULL,
  old_value  jsonb,             -- null = no override before
  new_value  jsonb,             -- null = override removed
  reason     text,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_override_history_t ON platform.tenant_override_history (tenant_id, changed_at DESC);

-- Monthly / lifetime meters. live_count limits (users, locations) are counted live, not metered.
CREATE TABLE platform.usage_meter (
  tenant_id   uuid NOT NULL REFERENCES platform.tenant(id),
  limit_key   text NOT NULL REFERENCES platform.limit_catalog(key),
  period      text NOT NULL,    -- 'YYYY-MM' in tenant timezone, or 'lifetime'
  used        bigint NOT NULL DEFAULT 0,
  warned_80   boolean NOT NULL DEFAULT false,
  warned_100  boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, limit_key, period)
);

-- Super Admin team
CREATE TABLE platform.platform_user (
  id                   uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  email                citext NOT NULL UNIQUE,
  name                 text NOT NULL,
  role                 text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'support', 'billing')),
  password_hash        text NOT NULL,
  is_active            boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  failed_logins        int NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  version              int NOT NULL DEFAULT 1
);

-- Refresh-token sessions for both platform and tenant users. Lives in platform schema because
-- refresh happens before tenant context is known. Tenant-facing session lists filter by subject.
CREATE TABLE platform.auth_session (
  id                 uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  subject_type       text NOT NULL CHECK (subject_type IN ('platform', 'tenant')),
  subject_id         uuid NOT NULL,
  tenant_id          uuid REFERENCES platform.tenant(id),
  family_id          uuid NOT NULL,             -- rotation family; reuse of a rotated token revokes the family
  refresh_hash       text NOT NULL UNIQUE,      -- sha256 of the opaque refresh token
  replaced_by        uuid,
  impersonated_by    uuid,                      -- platform_user id when Super Admin logs in as tenant
  ip                 inet,
  user_agent         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  revoked_reason     text
);
CREATE INDEX auth_session_subject ON platform.auth_session (subject_type, subject_id) WHERE revoked_at IS NULL;
CREATE INDEX auth_session_family ON platform.auth_session (family_id);

-- Platform audit (Super Admin actions, impersonation start/stop). Hash-chained like app.audit_log.
CREATE TABLE platform.audit_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  tenant_id   uuid,
  before      jsonb,
  after       jsonb,
  ip          inet,
  user_agent  text,
  at          timestamptz NOT NULL DEFAULT now(),
  prev_hash   text,
  hash        text NOT NULL
);
CREATE INDEX platform_audit_tenant ON platform.audit_log (tenant_id, at DESC);

-- Global starter templates (forms, workflows, masters) copied into a tenant at creation.
-- Content is opaque JSON validated by the owning engine's schema (Phase 2+ fill this in).
CREATE TABLE platform.global_template (
  id          uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  kind        text NOT NULL CHECK (kind IN ('bundle', 'form', 'workflow', 'master', 'role', 'pdf', 'email', 'whatsapp')),
  key         text NOT NULL,
  name        text NOT NULL,
  description text,
  content     jsonb NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1,
  UNIQUE (kind, key)
);

CREATE TRIGGER plan_touch BEFORE UPDATE ON platform.plan FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER tenant_touch BEFORE UPDATE ON platform.tenant FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER platform_user_touch BEFORE UPDATE ON platform.platform_user FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER global_template_touch BEFORE UPDATE ON platform.global_template FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform TO platform_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA platform TO platform_user;

-- Effective entitlements.
--   platform.effective_features(tenant) / platform.effective_limit(key, tenant): platform role only.
--   app.my_features() / app.my_limit(key): SECURITY DEFINER, take NO tenant argument and read only the
--   tenant in the caller's context, so app_user can never ask about another tenant.
CREATE OR REPLACE FUNCTION platform.effective_features(p_tenant uuid)
RETURNS TABLE (feature_key text) LANGUAGE sql STABLE AS $$
  WITH sub AS (
    SELECT plan_id FROM platform.subscription WHERE tenant_id = p_tenant AND effective_to IS NULL
  ),
  base AS (
    SELECT pf.feature_key FROM platform.plan_feature pf JOIN sub ON sub.plan_id = pf.plan_id
  ),
  ov AS (
    SELECT key, (value)::text::boolean AS is_on FROM platform.tenant_override WHERE tenant_id = p_tenant AND kind = 'feature'
  )
  SELECT b.feature_key FROM base b WHERE NOT EXISTS (SELECT 1 FROM ov WHERE ov.key = b.feature_key AND NOT ov.is_on)
  UNION
  SELECT key FROM ov WHERE is_on
$$;

-- Returns NULL for unlimited. A limit key with neither plan value nor override is treated as 0 (not granted).
CREATE OR REPLACE FUNCTION platform.effective_limit(p_key text, p_tenant uuid)
RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN o.tenant_id IS NOT NULL THEN CASE WHEN o.value = 'null'::jsonb THEN NULL ELSE (o.value #>> '{}')::bigint END
    WHEN pl.plan_id IS NOT NULL THEN pl.value
    ELSE 0
  END
  FROM (SELECT 1) one
  LEFT JOIN platform.tenant_override o ON o.tenant_id = p_tenant AND o.kind = 'limit' AND o.key = p_key
  LEFT JOIN platform.subscription s ON s.tenant_id = p_tenant AND s.effective_to IS NULL
  LEFT JOIN platform.plan_limit pl ON pl.plan_id = s.plan_id AND pl.limit_key = p_key
$$;
GRANT EXECUTE ON FUNCTION platform.effective_features(uuid) TO platform_user;
GRANT EXECUTE ON FUNCTION platform.effective_limit(text, uuid) TO platform_user;

CREATE OR REPLACE FUNCTION app.my_features() RETURNS TABLE (feature_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, platform, app AS $$
  SELECT * FROM platform.effective_features(app.current_tenant_id())
$$;
CREATE OR REPLACE FUNCTION app.my_limit(p_key text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, platform, app AS $$
  SELECT platform.effective_limit(p_key, app.current_tenant_id())
$$;
-- Tenant status + subscription status for the tenant in context (used by the auth guard on every request).
CREATE OR REPLACE FUNCTION app.my_tenant_state() RETURNS TABLE (tenant_status text, subscription_status text, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, platform, app AS $$
  SELECT t.status, s.status, t.timezone FROM platform.tenant t
  LEFT JOIN platform.subscription s ON s.tenant_id = t.id AND s.effective_to IS NULL
  WHERE t.id = app.current_tenant_id()
$$;
REVOKE ALL ON FUNCTION app.my_features(), app.my_limit(text), app.my_tenant_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_features(), app.my_limit(text), app.my_tenant_state() TO app_user, platform_user;
