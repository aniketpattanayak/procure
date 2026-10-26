-- 0011 Procurement (Phase 4): vendor quote log, PO follow-ups, document revisions, PO tax lines.
-- Indent, vendor selection and PO are SYSTEM document types on the Phase 3 documents core (doc_type kind 'system',
-- module_key 'indent' | 'vendor_quotes' | 'purchase'); they need no tables of their own beyond these.
-- Owner: Procurement agents (contract frozen by Architect). ADR-0013.

-- Append-only vendor quote log per indent line. Editing = a new row with version + 1 and supersedes_id; the
-- previous row gets is_current = false (the only UPDATE ever made). Nothing is overwritten.
CREATE TABLE app.vendor_quote (
  id               uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id        uuid NOT NULL DEFAULT app.current_tenant_id(),
  indent_line_id   uuid NOT NULL REFERENCES app.document_line(id),
  item_id          uuid REFERENCES app.master_record(id),
  vendor_id        uuid NOT NULL REFERENCES app.master_record(id),
  version          int NOT NULL DEFAULT 1 CHECK (version >= 1),
  supersedes_id    uuid REFERENCES app.vendor_quote(id),
  is_current       boolean NOT NULL DEFAULT true,
  quoted_rate      numeric(18,4) NOT NULL CHECK (quoted_rate >= 0),
  currency         char(3) NOT NULL DEFAULT 'INR',
  uom_id           uuid REFERENCES app.master_record(id),
  moq              numeric(18,4),
  lead_time_days   int CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  valid_until      date,
  payment_terms_id uuid REFERENCES app.master_record(id),
  freight          numeric(18,4) NOT NULL DEFAULT 0 CHECK (freight >= 0),
  freight_basis    text NOT NULL DEFAULT 'lump_sum' CHECK (freight_basis IN ('lump_sum', 'per_unit')),
  tax_pct          numeric(7,4) NOT NULL DEFAULT 0 CHECK (tax_pct >= 0),
  -- Quantity slabs: [{ "fromQty": "0", "toQty": "999", "rate": "50" }, { "fromQty": "1000", "discountPct": "10" }]
  slabs            jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes            text,
  file_ids         uuid[] NOT NULL DEFAULT '{}',
  custom           jsonb NOT NULL DEFAULT '{}'::jsonb,
  logged_at        timestamptz NOT NULL DEFAULT now(),   -- date of the conversation (editable by the buyer)
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL
);
CREATE INDEX vendor_quote_line ON app.vendor_quote (tenant_id, indent_line_id, vendor_id, version DESC);
CREATE INDEX vendor_quote_current ON app.vendor_quote (tenant_id, indent_line_id) WHERE is_current;
CREATE INDEX vendor_quote_item_vendor ON app.vendor_quote (tenant_id, item_id, vendor_id, created_at DESC);
SELECT app.enable_tenant_rls('app.vendor_quote');

-- PO follow-up log (append-only): each conversation with the vendor; revised expected dates keep full history.
CREATE TABLE app.po_followup (
  id                     uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id              uuid NOT NULL DEFAULT app.current_tenant_id(),
  document_id            uuid NOT NULL REFERENCES app.document(id),
  line_id                uuid REFERENCES app.document_line(id),       -- NULL = whole PO
  contact_mode           text NOT NULL DEFAULT 'call' CHECK (contact_mode IN ('call', 'email', 'whatsapp', 'visit', 'other')),
  contact_person         text,
  promised_date          date,
  revised_expected_date  date,
  reason                 text,
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid NOT NULL
);
CREATE INDEX po_followup_doc ON app.po_followup (tenant_id, document_id, created_at DESC);
SELECT app.enable_tenant_rls('app.po_followup');

-- Document revisions (PO amendments: Rev 1, Rev 2 …). snapshot = full DocumentRow-shaped JSON of the revision
-- being replaced; diff = field/line changes to the new revision. Generic: any doc type may use it later.
CREATE TABLE app.document_revision (
  id           uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id(),
  document_id  uuid NOT NULL REFERENCES app.document(id),
  rev_no       int NOT NULL CHECK (rev_no >= 0),          -- 0 = original as first approved
  snapshot     jsonb NOT NULL,
  diff         jsonb,                                     -- RevisionDiff vs previous revision (NULL for rev 0)
  reason       text,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'withdrawn')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  UNIQUE (document_id, rev_no)
);
SELECT app.enable_tenant_rls('app.document_revision');
ALTER TABLE app.document ADD COLUMN rev_no int NOT NULL DEFAULT 0;

-- Per PO line tax breakdown computed by the GST engine (intra-state CGST+SGST vs inter-state IGST).
CREATE TABLE app.line_tax (
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id(),
  line_id        uuid NOT NULL REFERENCES app.document_line(id),
  document_id    uuid NOT NULL REFERENCES app.document(id),
  component      text NOT NULL CHECK (component IN ('cgst', 'sgst', 'igst', 'cess')),
  rate_pct       numeric(7,4) NOT NULL,
  taxable_amount numeric(18,4) NOT NULL,
  tax_amount     numeric(18,4) NOT NULL,
  PRIMARY KEY (tenant_id, line_id, component)
);
CREATE INDEX line_tax_doc ON app.line_tax (tenant_id, document_id);
SELECT app.enable_tenant_rls('app.line_tax');

GRANT SELECT, INSERT ON app.vendor_quote, app.po_followup, app.document_revision TO app_user, platform_user;
GRANT UPDATE (is_current) ON app.vendor_quote TO app_user, platform_user;
GRANT UPDATE (status, diff) ON app.document_revision TO app_user, platform_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.line_tax TO app_user, platform_user;
