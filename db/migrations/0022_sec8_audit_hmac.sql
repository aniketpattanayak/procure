-- 0022 Phase 8 security (SEC8-015): keyed audit hash chain. New rows are hashed with HMAC-SHA256 under AUDIT_HASH_KEY
-- (held outside the database), so someone with database write access can no longer recompute a valid chain after
-- editing, inserting or deleting rows. Each row records the algorithm that produced its hash:
--   'sha256'      - plain SHA-256 (every row written before this migration; the default keeps old app tasks working
--                   during a rolling deploy);
--   'hmac-sha256' - HMAC-SHA256 with AUDIT_HASH_KEY (written by the API/worker from now on).
-- The verifier accepts 'sha256' rows only before the first keyed row of a chain (no downgrade). Owner: security.
-- ADD COLUMN with a constant default is metadata-only: no UPDATE runs on the append-only tables.
ALTER TABLE app.audit_log ADD COLUMN hash_alg text NOT NULL DEFAULT 'sha256'
  CONSTRAINT audit_log_hash_alg CHECK (hash_alg IN ('sha256', 'hmac-sha256'));
ALTER TABLE platform.audit_log ADD COLUMN hash_alg text NOT NULL DEFAULT 'sha256'
  CONSTRAINT platform_audit_log_hash_alg CHECK (hash_alg IN ('sha256', 'hmac-sha256'));
