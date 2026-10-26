-- 0023: tenant custom domains + logo upload support
-- custom_domain: e.g. "procure.arv.com" set by tenant (requires permission)
-- allow_custom_domain: super-admin toggle per tenant
-- logo_url already exists in schema (added in 0002) — no change needed

ALTER TABLE platform.tenant
  ADD COLUMN IF NOT EXISTS custom_domain       text UNIQUE,
  ADD COLUMN IF NOT EXISTS allow_custom_domain boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN platform.tenant.custom_domain       IS 'Tenant-configured vanity domain, e.g. procure.arv.com. NULL = use platform subdomain only.';
COMMENT ON COLUMN platform.tenant.allow_custom_domain IS 'Super-admin grants tenant permission to set a custom domain.';
