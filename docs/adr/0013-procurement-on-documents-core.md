# ADR-0013 Procurement as system document types

Status: accepted (Phases 4/6/7)

Indent, vendor selection and PO are system doc types on the Phase 3 core; procurement adds only the quote log, follow-ups, revisions and line taxes as tables. Quantities flow indent → selection → PO through ledger events and line links, consumed at submit under row locks so two buyers can never order the same remaining quantity. GST is an engine rule driven by data (tax_code master, vendor and ship-to state codes), not tenant code.
