# ADR-0003 Kysely and plain SQL migrations instead of an ORM

Status: accepted

We need `SET LOCAL`, RLS, ltree, ordered `FOR UPDATE`, JSONB expression indexes and partial indexes.
Kysely gives typed queries without hiding SQL. Migrations are forward-only `.sql` files applied by
`db/migrate.mjs` (checksummed; editing an applied migration fails). dbmate was proposed in the design pack;
a 60-line runner removes a binary dependency and behaves the same.
