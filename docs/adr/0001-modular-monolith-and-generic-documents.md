# ADR-0001 Modular monolith with generic documents

Status: accepted (Gate 1 design pack, 2026-10-22)

We build one NestJS app split into modules with one owner each, and store every transaction type in one
`document` / `document_line` / `line_event` shape keyed by `doc_type`. Engines (workflow, permissions,
numbering, PDF, reports) then work on any document type, including tenant-defined ones, with one code path.
Consequence: wider tables and per-type partial indexes; partitioning by tenant hash is available later.
