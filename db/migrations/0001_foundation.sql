-- 0001 Foundation: extensions, roles, schemas, helpers
-- Owner: Architect. Frozen for Phase 1; changes need an ADR.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS ltree;

-- Two schemas:
--   platform : cross-tenant tables, reachable only by the platform role (Super Admin + auth)
--   app      : tenant tables; every table MUST have tenant_id + RLS policy + FORCE RLS (enforced by db/policies/rls-lint.mjs)
CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_pass' NOBYPASSRLS NOSUPERUSER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_user') THEN
    CREATE ROLE platform_user LOGIN PASSWORD 'platform_pass' BYPASSRLS NOSUPERUSER;
  END IF;
END$$;

GRANT USAGE ON SCHEMA app TO app_user, platform_user;
GRANT USAGE ON SCHEMA platform TO platform_user;
-- app_user may read a narrow set of platform data through SECURITY DEFINER functions only (see 0002).

ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user, platform_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO app_user, platform_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform GRANT USAGE, SELECT ON SEQUENCES TO platform_user;

-- Time-ordered UUID v7 (index-friendly, non-guessable enough for IDs; never used as an authz boundary)
CREATE OR REPLACE FUNCTION app.uuid_v7() RETURNS uuid LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  ts bigint := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  b bytea := gen_random_bytes(16);
BEGIN
  b := set_byte(b, 0, ((ts >> 40) & 255)::int);
  b := set_byte(b, 1, ((ts >> 32) & 255)::int);
  b := set_byte(b, 2, ((ts >> 24) & 255)::int);
  b := set_byte(b, 3, ((ts >> 16) & 255)::int);
  b := set_byte(b, 4, ((ts >> 8) & 255)::int);
  b := set_byte(b, 5, (ts & 255)::int);
  b := set_byte(b, 6, ((get_byte(b, 6) & 15) | 112));   -- version 7
  b := set_byte(b, 8, ((get_byte(b, 8) & 63) | 128));   -- variant
  RETURN encode(b, 'hex')::uuid;
END$$;
GRANT EXECUTE ON FUNCTION app.uuid_v7() TO app_user, platform_user;

-- Tenant context. Set per request with SET LOCAL app.tenant_id = '<uuid>' inside a transaction.
-- Missing context => NULL => every RLS predicate is false => zero rows (fail closed).
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO app_user, platform_user;

CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END$$;

-- Helper used by every tenant-table migration:
--   SELECT app.enable_tenant_rls('app.some_table');
CREATE OR REPLACE FUNCTION app.enable_tenant_rls(tbl regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
    tbl);
END$$;
