# ADR-0010 Generic documents, custom document types and the quantity ledger

Status: accepted (Phase 3)

All transactions share `document` / `document_line`; a `doc_type` row (header form + optional line form + settings)
defines each type. Tenants create custom types (e.g. Capex Request) without code; Phase 4–5 modules provision
system types (indent, PO, GRN, issue) through the same table and add module behaviour around the core.
System fields (location, dates, party, total; item, uom, qty, rate, amount, required date) are columns, mapped from
reserved form field keys; everything else is `custom` JSONB validated by the form engine. Quantities change only via
`line_event` (append-only) with `line_qty_summary` maintained in the same transaction; status keys are derived.
Item-wise views read lines + summaries with no ledger aggregation at read time.
