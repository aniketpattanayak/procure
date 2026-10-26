# ADR-0002 Tenant isolation with RLS and two database roles

Status: accepted

- Tenant tables live in schema `app`; each has `tenant_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY` and policy
  `tenant_isolation` comparing to `app.current_tenant_id()` (from `SET LOCAL app.tenant_id`).
- Application tenant traffic uses role `app_user` (NOBYPASSRLS). Missing context returns zero rows.
- Cross-tenant tables live in schema `platform`, reachable only by role `platform_user` (BYPASSRLS), used by
  Super Admin endpoints and login/refresh.
- `app_user` reads its own entitlements through SECURITY DEFINER functions that take no tenant argument
  (`app.my_features()`, `app.my_limit()`, `app.consume_quota()`), so it cannot query another tenant's plan.
- CI: `db/policies/rls-lint.mjs` fails if any `app.*` table lacks the policy; the isolation suite proves it.
