# ADR-0009 RLS prevents GIN use for non-leakproof operators; no LEAKPROOF override

Status: accepted (Phase 2 review)

With `FORCE ROW LEVEL SECURITY`, PostgreSQL may only use an index for an operator that is `LEAKPROOF`.
`jsonb @>` (`jsonb_contains`) and `@@` (`ts_match_vq`) are not, so master-record option searches combining text
search and cascade filters scan the tenant's rows instead of using the GIN indexes (QA2-BUG-009). Measured at 50,000
records in one master: ~17 ms; with the operators marked LEAKPROOF: ~4–8 ms.

Decision: do **not** mark built-in operators LEAKPROOF. It needs true superuser, which AWS RDS (our production
target, ADR/design pack) does not grant, and it widens what every RLS-protected query may leak. Current numbers are
well inside the 300 ms p95 target. Mitigations if load tests (Phase 8) show a problem, in order:
1. Expression b-tree indexes on hot cascade keys (`(tenant_id, master_id, (data->>'category'))`) — b-tree text
   equality is leakproof, so these are usable under RLS; queries then use `data->>'k' = $1` instead of `@>`.
2. A plain `name_lower text` column with a `text_pattern_ops` index for prefix search instead of tsvector.
3. Hash-partition `master_record` by tenant.
