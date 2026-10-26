# ADR-0015 Report definitions compiled over an allow-listed catalogue

Status: accepted (Phases 4/6/7)

Reports are JSON definitions over sources generated from configuration (doc types, masters) or registered by modules. The compiler maps catalogue field ids to SQL expressions via Kysely, so user input never becomes SQL; RLS, data scope, view permissions and field access apply automatically. Exports and schedules are background jobs producing expiring files.
