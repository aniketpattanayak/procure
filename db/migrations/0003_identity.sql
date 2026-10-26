-- 0003 Identity & tenant core: users, roles, grants (stub, extended in Phase 2), settings,
-- tenant audit log, in-app notifications, quota consumption.
-- Owner: Platform & tenancy agent; permission_grant shape owned by Permissions agent from Phase 2.

CREATE TABLE app.tenant_user (
  id                   uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id            uuid NOT NULL DEFAULT app.current_tenant_id(),
  email                citext NOT NULL,
  name                 text NOT NULL,
  phone                text,
  password_hash        text NOT NULL,
  is_tenant_admin      boolean NOT NULL DEFAULT false,
  is_active            boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  failed_logins        int NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  two_factor           text NOT NULL DEFAULT 'off' CHECK (two_factor IN ('off', 'email', 'whatsapp')),
  reporting_manager_id uuid REFERENCES app.tenant_user(id),
  custom               jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_login_at        timestamptz,
  password_changed_at  timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid,
  version              int NOT NULL DEFAULT 1,
  is_deleted           boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, email)
);
CREATE INDEX tenant_user_active ON app.tenant_user (tenant_id) WHERE is_active AND NOT is_deleted;
SELECT app.enable_tenant_rls('app.tenant_user');
CREATE TRIGGER tenant_user_touch BEFORE UPDATE ON app.tenant_user FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.role (
  id          uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id   uuid NOT NULL DEFAULT app.current_tenant_id(),
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name        text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false,   -- 'tenant_admin' role cannot be deleted
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1,
  is_deleted  boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, key)
);
SELECT app.enable_tenant_rls('app.role');
CREATE TRIGGER role_touch BEFORE UPDATE ON app.role FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.user_role (
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id(),
  user_id   uuid NOT NULL REFERENCES app.tenant_user(id),
  role_id   uuid NOT NULL REFERENCES app.role(id),
  PRIMARY KEY (tenant_id, user_id, role_id)
);
SELECT app.enable_tenant_rls('app.user_role');

-- Grants: role-level or user-level, allow or deny, on a registry key.
-- Phase 2 (Permissions agent) adds registry table and data-scope columns.
CREATE TABLE app.permission_grant (
  id         uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id  uuid NOT NULL DEFAULT app.current_tenant_id(),
  role_id    uuid REFERENCES app.role(id),
  user_id    uuid REFERENCES app.tenant_user(id),
  perm_key   text NOT NULL,
  effect     text NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow', 'deny')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CHECK ((role_id IS NULL) <> (user_id IS NULL))
);
CREATE UNIQUE INDEX permission_grant_role_key ON app.permission_grant (tenant_id, role_id, perm_key) WHERE role_id IS NOT NULL;
CREATE UNIQUE INDEX permission_grant_user_key ON app.permission_grant (tenant_id, user_id, perm_key) WHERE user_id IS NOT NULL;
SELECT app.enable_tenant_rls('app.permission_grant');

-- Typed tenant settings; defaults live in the platform settings registry in code-free JSON (packages/schema/settings.ts).
CREATE TABLE app.tenant_setting (
  tenant_id  uuid NOT NULL DEFAULT app.current_tenant_id(),
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  PRIMARY KEY (tenant_id, key)
);
SELECT app.enable_tenant_rls('app.tenant_setting');

-- Tenant audit log: append-only, hash-chained per tenant (prev_hash -> hash). UPDATE/DELETE revoked.
CREATE TABLE app.audit_log (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL DEFAULT app.current_tenant_id(),
  actor_id        uuid,
  impersonated_by uuid,
  action          text NOT NULL,          -- 'create' | 'update' | 'delete' | 'approve' | 'login' | ...
  entity          text NOT NULL,          -- 'user' | 'role' | 'document' | ...
  entity_id       text,
  before          jsonb,
  after           jsonb,
  ip              inet,
  user_agent      text,
  at              timestamptz NOT NULL DEFAULT now(),
  prev_hash       text,
  hash            text NOT NULL
);
CREATE INDEX audit_log_entity ON app.audit_log (tenant_id, entity, entity_id, at DESC);
CREATE INDEX audit_log_at ON app.audit_log (tenant_id, at DESC);
SELECT app.enable_tenant_rls('app.audit_log');
-- Append-only: insert allowed through RLS; app_user gets no UPDATE/DELETE.

CREATE TABLE app.notification (
  id         uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id  uuid NOT NULL DEFAULT app.current_tenant_id(),
  user_id    uuid NOT NULL REFERENCES app.tenant_user(id),
  kind       text NOT NULL,            -- 'limit_warning' | 'approval_pending' | 'mention' | ...
  title      text NOT NULL,
  body       text,
  link       text,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_unread ON app.notification (tenant_id, user_id, created_at DESC) WHERE read_at IS NULL;
SELECT app.enable_tenant_rls('app.notification');

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_user, platform_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO app_user, platform_user;
REVOKE UPDATE, DELETE ON app.audit_log FROM app_user, platform_user;

-- Atomic quota consumption for monthly/lifetime meters (WhatsApp, email, API calls, storage).
-- Returns (allowed, used, lim, crossed) where crossed in ('80','100',NULL) signals a new warning to emit.
CREATE OR REPLACE FUNCTION app.consume_quota(p_key text, p_amount bigint, p_period text)
RETURNS TABLE (allowed boolean, used bigint, lim bigint, crossed text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, platform, app AS $$
DECLARE
  t uuid := app.current_tenant_id();
  l bigint;
  m platform.usage_meter;
BEGIN
  IF t IS NULL THEN RAISE EXCEPTION 'no tenant context'; END IF;
  l := platform.effective_limit(p_key, t);
  INSERT INTO platform.usage_meter (tenant_id, limit_key, period) VALUES (t, p_key, p_period)
    ON CONFLICT DO NOTHING;
  SELECT * INTO m FROM platform.usage_meter WHERE tenant_id = t AND limit_key = p_key AND period = p_period FOR UPDATE;
  IF l IS NOT NULL AND m.used + p_amount > l THEN
    crossed := CASE WHEN NOT m.warned_100 THEN '100' END;
    UPDATE platform.usage_meter SET warned_100 = true, updated_at = now()
      WHERE tenant_id = t AND limit_key = p_key AND period = p_period;
    RETURN QUERY SELECT false, m.used, l, crossed;
    RETURN;
  END IF;
  UPDATE platform.usage_meter SET used = m.used + p_amount, updated_at = now()
    WHERE tenant_id = t AND limit_key = p_key AND period = p_period;
  crossed := NULL;
  IF l IS NOT NULL AND l > 0 THEN
    IF (m.used + p_amount) >= l AND NOT m.warned_100 THEN
      crossed := '100';
      UPDATE platform.usage_meter SET warned_100 = true, warned_80 = true WHERE tenant_id = t AND limit_key = p_key AND period = p_period;
    ELSIF (m.used + p_amount) * 100 >= l * 80 AND NOT m.warned_80 THEN
      crossed := '80';
      UPDATE platform.usage_meter SET warned_80 = true WHERE tenant_id = t AND limit_key = p_key AND period = p_period;
    END IF;
  END IF;
  RETURN QUERY SELECT true, m.used + p_amount, l, crossed;
END$$;
REVOKE ALL ON FUNCTION app.consume_quota(text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.consume_quota(text, bigint, text) TO app_user, platform_user;

-- Serialises live-count limit checks (users, locations) per tenant and returns the effective limit.
CREATE OR REPLACE FUNCTION app.lock_tenant_for_limit(p_key text) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, platform, app AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text || ':' || p_key, 0));
  RETURN platform.effective_limit(p_key, app.current_tenant_id());
END$$;
REVOKE ALL ON FUNCTION app.lock_tenant_for_limit(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_tenant_for_limit(text) TO app_user, platform_user;
