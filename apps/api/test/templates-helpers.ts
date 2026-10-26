/**
 * Fixtures for the templates & PDF suites (templates.*.test.ts): a tenant with letterhead data (legal name, GSTIN,
 * address, logo file), vendor / payment terms / T&C records, and a PO-like custom document type `pox` with GST rows.
 */
import { decodeImage } from '../src/modules/files/image';
import { API, bearer, Ctx, uid } from './helpers';
import { api, mustOk } from './forms-helpers';
import { DocsFixture, docsTenant } from './documents-helpers';

export const POX_HEADER = [
  { key: 'party', type: 'lookup', label: 'Vendor', source: { kind: 'master', masterKey: 'vendor' }, display: ['code', 'name'] },
  { key: 'payment_terms', type: 'lookup', label: 'Payment terms', source: { kind: 'master', masterKey: 'payment_terms' } },
  { key: 'terms', type: 'multilookup', label: 'Terms', source: { kind: 'master', masterKey: 'terms' } },
  { key: 'freight', type: 'currency', label: 'Freight' },
  { key: 'other_charges', type: 'currency', label: 'Other charges' },
  { key: 'discount_amount', type: 'currency', label: 'Discount' },
  { key: 'expected_date', type: 'date', label: 'Expected delivery' },
  { key: 'priority', type: 'select', label: 'Priority', options: [{ value: 'N', label: 'Normal' }, { value: 'U', label: 'Urgent' }] },
  { key: 'remarks', type: 'textarea', label: 'Remarks' },
];
export const POX_LINE = [
  { key: 'discount_pct', type: 'percentage', label: 'Discount %' },
  { key: 'remarks', type: 'text', label: 'Line remarks' },
];

/** A small two-colour PNG logo. */
export async function logoPng(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" rx="10" fill="#12355b"/>
    <circle cx="40" cy="40" r="22" fill="#f2a900"/><text x="75" y="52" font-family="DejaVu Sans" font-size="34" font-weight="bold" fill="#fff">ACME</text></svg>`;
  return decodeImage(Buffer.from(svg)).png().toBuffer();
}

export interface TplFixture extends DocsFixture {
  vendorId: string;
  vendorIgstId: string;
  paymentTermsId: string;
  termIds: string[];
  logoFileId: string;
}

/** docsTenant + letterhead + masters for PO-like documents + the `pox` custom type. */
export async function tplTenant(c: Ctx): Promise<TplFixture> {
  const f = await docsTenant(c);
  const a = api(c, f.token);
  const up = await c.http.post(`${API}/files`).set(bearer(f.token)).attach('file', await logoPng(), 'logo.png');
  if (up.status !== 201) throw new Error(`logo upload ${up.status} ${JSON.stringify(up.body)}`);
  await c.db.updateTable('platform.tenant').set({
    legal_name: 'Acme Industries Private Limited', logo_url: `https://cdn.example.test/api/v1/files/${up.body.id}/content`,
    tax_ids: JSON.stringify({ gstin: '27AABCA1234F1Z9', pan: 'AABCA1234F' }),
    address: JSON.stringify({ line1: 'Plot 14, MIDC Bhosari', city: 'Pune', postalCode: '411026', state: 'Maharashtra', stateCode: '27', country: 'IN' }),
  }).where('id', '=', f.tenantId).execute();
  const vendor = await mustOk(a.post('/masters/vendor/records', {
    name: 'Deccan Steel Traders', data: { gstin: '27AAFCD5678K1Z3', address: '22 Industrial Estate, Hadapsar\nPune 411013', state_code: '27', email: 'sales@deccan.test', phone: '+919876543210' },
  }), 201);
  const vendor2 = await mustOk(a.post('/masters/vendor/records', { name: 'Kaveri Polymers', data: { gstin: '29AAKCK1111L1ZH', state_code: '29' } }), 201);
  const pt = await mustOk(a.post('/masters/payment_terms/records', { code: `NET30${uid(3)}`, name: '30 days credit', data: { credit_days: '30' } }), 201);
  const t1 = await mustOk(a.post('/masters/terms/records', { code: `DEL${uid(3)}`, name: 'Delivery', data: { body: 'Deliver to the ship-to address between 9 AM and 5 PM on working days.' } }), 201);
  const t2 = await mustOk(a.post('/masters/terms/records', { code: `INV${uid(3)}`, name: 'Invoicing', data: { body: 'Quote the PO number on every invoice & challan.' } }), 201);
  await mustOk(a.post('/config/doc-types', {
    key: 'pox', name: 'Purchase Order X', pluralName: 'Purchase Orders X', headerDefinition: { fields: POX_HEADER }, lineDefinition: { fields: POX_LINE },
    numberPattern: 'POX/{FYS}/{SEQ:4}',
  }), 201);
  // the item master's HSN code
  for (const [i, id] of f.items.entries()) {
    await c.db.updateTable('app.master_record').set({ data: JSON.stringify({ uom: f.uom, hsn_code: i === 0 ? '8471' : '8443' }) }).where('id', '=', id).execute();
  }
  return { ...f, vendorId: vendor.id, vendorIgstId: vendor2.id, paymentTermsId: pt.id, termIds: [t1.id, t2.id], logoFileId: up.body.id };
}

export function poxBody(f: TplFixture, over: Record<string, unknown> = {}) {
  return {
    values: {
      location: f.pune, doc_date: '2026-10-05', party: f.vendorId, payment_terms: f.paymentTermsId, terms: f.termIds, freight: '500', other_charges: '0',
      discount_amount: '100', expected_date: '2026-10-20', priority: 'U', remarks: '<b>Rush</b> <script>alert(1)</script>', ...over,
    },
    lines: [
      { values: { item: f.items[0], qty: '10', rate: '1250.50', discount_pct: '0', remarks: 'Core i7 & 16 GB' } },
      { values: { item: f.items[1], qty: '3', rate: '45000' } },
    ],
  };
}

/** Creates (and by default submits) a pox document and writes CGST+SGST 9% rows for its lines. */
export async function poxDoc(c: Ctx, f: TplFixture, opts: { submit?: boolean; over?: Record<string, unknown>; tax?: 'intra' | 'inter' | 'none' } = {}) {
  const a = api(c, f.token);
  let doc = await mustOk(a.post('/docs/pox', poxBody(f, opts.over)), 201);
  if (opts.submit !== false) doc = await mustOk(a.post(`/docs/pox/${doc.id}/submit`, { version: doc.version }));
  const tax = opts.tax ?? 'intra';
  if (tax !== 'none') {
    for (const l of doc.lines as { id: string; values: { amount: string } }[]) {
      const comps = tax === 'intra' ? [['cgst', 9], ['sgst', 9]] as const : [['igst', 18]] as const;
      for (const [component, rate] of comps) {
        const taxable = Number(l.values.amount);
        await c.db.insertInto('app.line_tax').values({
          tenant_id: f.tenantId, line_id: l.id, document_id: doc.id, component, rate_pct: rate, taxable_amount: taxable.toFixed(2), tax_amount: (taxable * rate / 100).toFixed(2),
        }).execute();
      }
    }
  }
  return doc as { id: string; version: number; number: string | null; lines: { id: string }[] };
}

/**
 * Tenancy-isolation seed for the templates tables (tenancy-isolation.test.ts seedSide()): message_template rows come
 * from provisioning (starter templates); a generated_pdf row (queued, no file) is inserted as the DB owner.
 */
export async function seedTemplatesIsolation(c: Ctx, s: { tenantId: string; documentId: string }) {
  const { TemplatesInstaller } = await import('../src/modules/templates');
  const { DbService } = await import('../src/core/db.service');
  await c.app.get(DbService).tenantTx(s.tenantId, tx => c.app.get(TemplatesInstaller).ensure(tx, s.tenantId));
  const t = await c.db.selectFrom('app.message_template').select(['id', 'version']).where('tenant_id', '=', s.tenantId).where('channel', '=', 'pdf')
    .orderBy('key').limit(1).executeTakeFirstOrThrow();
  const row = await c.db.insertInto('app.generated_pdf').values({ tenant_id: s.tenantId, document_id: s.documentId, template_id: t.id, template_version: t.version, document_version: 1 })
    .returning('id').executeTakeFirstOrThrow();
  return { templateId: t.id, generatedPdfId: row.id };
}
