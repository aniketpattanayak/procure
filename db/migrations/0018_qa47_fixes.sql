-- QA47-BUG-001: when the selection approver rejects / cancels over-approved quantity, the over-approval it no longer
-- needs is taken back with a new ledger event `over_approval_cancelled` (over_approved bucket −qty). Additive only.
ALTER TABLE app.line_event DROP CONSTRAINT IF EXISTS line_event_event_type_check;
ALTER TABLE app.line_event ADD CONSTRAINT line_event_event_type_check CHECK (event_type IN (
  'requested', 'approved', 'held', 'unheld', 'rejected', 'cancelled', 'short_closed', 'over_approved', 'over_approval_cancelled',
  'selected', 'selection_cancelled', 'ordered', 'order_cancelled', 'received', 'accepted',
  'rejected_at_receipt', 'issued', 'returned'));

-- QA47-BUG-006: PDFs render with the requester's field access. The cache key gains the access variant: `access_key`
-- ('' = full access, as for workflow effects and automatic sends) and the hidden field keys the worker strips.
ALTER TABLE app.generated_pdf ADD COLUMN access_key text NOT NULL DEFAULT '';
ALTER TABLE app.generated_pdf ADD COLUMN hidden_fields jsonb;
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid = 'app.generated_pdf'::regclass AND contype = 'u';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE app.generated_pdf DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE app.generated_pdf ADD CONSTRAINT generated_pdf_cache_key
  UNIQUE (tenant_id, document_id, template_id, template_version, document_version, access_key);

-- QA47-BUG-006: a manual send renders with the sender's field access; the attached PDF / WhatsApp variables (rendered
-- at send time) use the hidden field keys stored here (null = full access).
ALTER TABLE app.outbound_message ADD COLUMN render_hidden jsonb;
