-- 0021 Phase 8 security (SEC8-007): the platform audit log is append-only for the application role, like
-- app.audit_log (0003). 0002 granted UPDATE/DELETE on every platform table to platform_user; no code path needs them on
-- audit_log, and they would let a compromised API rewrite the Super Admin trail. Owner: security.
REVOKE UPDATE, DELETE, TRUNCATE ON platform.audit_log FROM platform_user;
