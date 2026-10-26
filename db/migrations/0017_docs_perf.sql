-- 0017 Documents list / inbox performance (QA3-BUG-017, QA3-BUG-018). Owner: Phase 3 fix agent.
--
-- Item-wise list without a single status filter (every status the caller can see), default order created_at desc:
-- document_line_itemwise leads with status_key, so it cannot return lines in created_at order across several statuses.
-- This one lets DocListService walk lines newest-first and stop after one page (the document/location/search
-- conditions are checked per line).
CREATE INDEX IF NOT EXISTS document_line_itemwise_all ON app.document_line (tenant_id, doc_type_id, created_at DESC, id) WHERE NOT is_deleted;

-- Approvals inbox: active stages newest-first, so one inbox page is read from the top of this index with the
-- "may I act" check per row instead of collecting every waiting document in the caller's scope first.
CREATE INDEX IF NOT EXISTS wf_stage_state_active ON app.wf_stage_state (tenant_id, entered_at DESC, instance_id, stage_key) WHERE status = 'active';
