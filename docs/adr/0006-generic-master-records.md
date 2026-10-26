# ADR-0006 One table for all master records

Status: accepted (Phase 2)

Every master (system or tenant-created) stores records in `app.master_record` with real columns only for
`code`, `name`, `is_active` and bookkeeping; all other values are in `data` JSONB validated against the form version
the record was saved with. Lookup values are record ids. `app.record_ref` indexes every reference for delete
protection and "where used". Cascading filters use `data @> {"field": "<id>"}` on a `jsonb_path_ops` GIN index.
Items and vendors are master records; later modules reference `master_record.id`. Frequently filtered keys can get
expression indexes later without schema changes to the API.

**Note (Phase 2 QA, QA2-BUG-009).** Sorting a record list by a data key is allowed only for keys in the master's
`settings.listColumns`. It has no index, so it reads every live record of that master; that is fine up to tens of
thousands of rows. A very large master that is regularly sorted by a key should get an expression index in a
migration, e.g. `CREATE INDEX … ON app.master_record (tenant_id, master_id, is_active, ((data->>'std_rate')::numeric), id)
WHERE NOT is_deleted AND master_id = '<id>'` (numeric keys use the `coalesce((data->>k)::numeric, 0)` expression the
API sorts by). Under FORCE RLS the GIN indexes on `data` (`@>`) and `search` (`@@`) are only usable by `app_user` when
`jsonb_contains` and `ts_match_vq` are marked `LEAKPROOF` (otherwise the planner must evaluate them after the policy
qual and cannot use them as index conditions).
