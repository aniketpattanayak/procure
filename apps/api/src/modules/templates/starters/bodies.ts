import { DRAFT_WATERMARK, letterhead, pageFooter, PRINT_CSS } from './styles';

/** Starter Handlebars layouts. Context: packages/schema/src/notify.ts + templates/context.service.ts. */

// ---------------------------------------------------------------------------------------------- Purchase order
// QA47-BUG-007: the header discount is a before-tax trade discount (already inside the taxable value), so it is shown
// above "Taxable value"; only a part not allocated into taxable (e.g. on untaxed lines) is deducted after tax.
const PO_TOTALS_TAXABLE = `    {{#ifEq totals.discountBeforeTax "0.00"}}{{else}}<tr><td>Amount before discount</td><td class="num">{{formatMoney totals.preDiscount document.currency}}</td></tr>
    <tr><td>Less: discount</td><td class="num">− {{formatMoney totals.discountBeforeTax document.currency}}</td></tr>{{/ifEq}}
    <tr><td>Taxable value</td><td class="num">{{formatMoney totals.taxable document.currency}}</td></tr>
`;
const PO_TOTALS_DISCOUNT_AFTER_TAX = `    {{#ifEq totals.discountAfterTax "0.00"}}{{else}}{{#if totals.discountAfterTax}}<tr><td>Discount</td><td class="num">− {{formatMoney totals.discountAfterTax document.currency}}</td></tr>{{/if}}{{/ifEq}}
`;
const PO_TOTALS_V1_TAXABLE = `    <tr><td>Taxable value</td><td class="num">{{formatMoney totals.taxable document.currency}}</td></tr>
`;
const PO_TOTALS_V1_DISCOUNT = `    {{#ifEq totals.discount "0.00"}}{{else}}<tr><td>Discount</td><td class="num">− {{formatMoney totals.discount document.currency}}</td></tr>{{/ifEq}}
`;

export const PO_BODY = `${PRINT_CSS}
<div class="doc">
${DRAFT_WATERMARK}
${letterhead('Purchase Order')}

<div class="facts">
  <div><div class="label">PO number</div><div class="value">{{#if document.number}}{{document.number}}{{else}}Not issued{{/if}}{{#if document.revNo}} · Rev {{document.revNo}}{{/if}}</div></div>
  <div><div class="label">PO date</div><div class="value">{{formatDate document.docDate}}</div></div>
  <div><div class="label">Expected delivery</div><div class="value">{{#if document.values.expected_date}}{{formatDate document.values.expected_date}}{{else}}As per schedule{{/if}}</div></div>
  <div><div class="label">Payment terms</div><div class="value">{{#if document.display.payment_terms}}{{document.display.payment_terms}}{{else}}{{#if document.party.paymentTerms}}{{document.party.paymentTerms}}{{else}}As agreed{{/if}}{{/if}}</div></div>
</div>

<div class="parties">
  <div class="box">
    <h3>Supplier</h3>
    {{#with document.party}}
      <div class="name">{{name}}</div>
      {{#if address}}<div class="tbody">{{address}}</div>{{/if}}
      <div class="kv">
        <span class="k">Vendor code</span><span>{{code}}</span>
        {{#if gstin}}<span class="k">GSTIN</span><span>{{gstin}}</span>{{/if}}
        {{#if state_code}}<span class="k">State code</span><span>{{state_code}}</span>{{/if}}
        {{#if phone}}<span class="k">Phone</span><span>{{phone}}</span>{{/if}}
        {{#if email}}<span class="k">Email</span><span>{{email}}</span>{{/if}}
      </div>
    {{else}}
      <div class="muted">Supplier not selected</div>
    {{/with}}
  </div>
  <div class="box">
    <h3>Ship to / Bill to</h3>
    <div class="name">{{tenant.legalName}}</div>
    <div>{{document.location.name}} ({{document.location.code}})</div>
    {{#if tenant.addressText}}<div>{{tenant.addressText}}</div>{{/if}}
    <div class="kv">
      {{#if tenant.gstin}}<span class="k">GSTIN</span><span>{{tenant.gstin}}</span>{{/if}}
      {{#if document.location.values.state_code}}<span class="k">State code</span><span>{{document.location.values.state_code}}</span>{{else}}{{#if tenant.stateCode}}<span class="k">State code</span><span>{{tenant.stateCode}}</span>{{/if}}{{/if}}
      <span class="k">Currency</span><span>{{document.currency}}</span>
    </div>
  </div>
</div>

<table class="items">
  <thead>
    <tr>
      <th class="center" style="width:22px">#</th>
      <th>Item &amp; description</th>
      <th style="width:52px">HSN/SAC</th>
      <th class="num" style="width:58px">Qty</th>
      <th style="width:34px">Unit</th>
      <th class="num" style="width:66px">Rate</th>
      {{#if totals.hasTax}}
        <th class="num" style="width:72px">Taxable</th>
        {{#if totals.isInterState}}<th class="num" style="width:74px">IGST</th>{{else}}<th class="num" style="width:66px">CGST</th><th class="num" style="width:66px">SGST</th>{{/if}}
      {{/if}}
      <th class="num" style="width:78px">Amount</th>
    </tr>
  </thead>
  <tbody>
    {{#each lines}}
    <tr{{#if cancelled}} class="cancelled"{{/if}}>
      <td class="center">{{#if sr}}{{sr}}{{else}}–{{/if}}</td>
      <td>
        <div class="strong">{{#if item}}{{item.name}}{{else}}{{display.description}}{{/if}}</div>
        <div class="sub">{{#if item}}{{item.code}}{{/if}}{{#if values.remarks}} · {{values.remarks}}{{/if}}{{#if values.expected_date}} · Due {{formatDate values.expected_date}}{{/if}}</div>
      </td>
      <td>{{item.hsn}}</td>
      <td class="num">{{formatNumber qty 2}}</td>
      <td>{{uom}}</td>
      <td class="num">{{formatNumber rate 2}}{{#if values.discount_pct}}<div class="sub">less {{values.discount_pct}}%</div>{{/if}}</td>
      {{#if ../totals.hasTax}}
        <td class="num">{{formatNumber taxable 2}}</td>
        {{#if ../totals.isInterState}}
          <td class="num">{{#if igst}}{{formatNumber igst.taxAmount 2}}<div class="sub">@ {{igst.ratePct}}%</div>{{else}}–{{/if}}</td>
        {{else}}
          <td class="num">{{#if cgst}}{{formatNumber cgst.taxAmount 2}}<div class="sub">@ {{cgst.ratePct}}%</div>{{else}}–{{/if}}</td>
          <td class="num">{{#if sgst}}{{formatNumber sgst.taxAmount 2}}<div class="sub">@ {{sgst.ratePct}}%</div>{{else}}–{{/if}}</td>
        {{/if}}
        <td class="num strong">{{formatNumber total 2}}</td>
      {{else}}
        <td class="num strong">{{formatNumber amount 2}}</td>
      {{/if}}
    </tr>
    {{/each}}
  </tbody>
</table>

<div class="summary">
  <div>
    <div class="words"><div class="label">Amount in words</div><div class="strong">{{amountInWords totals.grand document.currency}}</div></div>
    {{#if totals.breakup.length}}
    <div class="section-title">Tax summary</div>
    <table class="approvals">
      <thead><tr><th>Tax</th><th class="num">Taxable value</th><th class="num">Tax amount</th></tr></thead>
      <tbody>{{#each totals.breakup}}<tr><td>{{label}}</td><td class="num">{{formatMoney taxable ../document.currency}}</td><td class="num">{{formatMoney amount ../document.currency}}</td></tr>{{/each}}</tbody>
    </table>
    {{/if}}
  </div>
  <table class="totals">
${PO_TOTALS_TAXABLE}    {{#if totals.hasTax}}
      {{#if totals.isInterState}}
        <tr><td>IGST</td><td class="num">{{formatMoney totals.igst document.currency}}</td></tr>
      {{else}}
        <tr><td>CGST</td><td class="num">{{formatMoney totals.cgst document.currency}}</td></tr>
        <tr><td>SGST</td><td class="num">{{formatMoney totals.sgst document.currency}}</td></tr>
      {{/if}}
      {{#ifEq totals.cess "0.00"}}{{else}}<tr><td>Cess</td><td class="num">{{formatMoney totals.cess document.currency}}</td></tr>{{/ifEq}}
    {{/if}}
    {{#ifEq totals.freight "0.00"}}{{else}}<tr><td>Freight</td><td class="num">{{formatMoney totals.freight document.currency}}</td></tr>{{/ifEq}}
    {{#ifEq totals.otherCharges "0.00"}}{{else}}<tr><td>Other charges</td><td class="num">{{formatMoney totals.otherCharges document.currency}}</td></tr>{{/ifEq}}
${PO_TOTALS_DISCOUNT_AFTER_TAX}    <tr class="grand"><td>Grand total</td><td class="num">{{formatMoney totals.grand document.currency}}</td></tr>
  </table>
</div>

{{#if terms.length}}
<div class="section-title">Terms &amp; conditions</div>
<ol class="terms">
  {{#each terms}}<li><span class="tname">{{name}}.</span> <span class="tbody">{{body}}</span></li>{{/each}}
</ol>
{{/if}}

{{#if approvals.length}}
<div class="section-title">Approvals</div>
<table class="approvals">
  <thead><tr><th>Stage</th><th>By</th><th>On</th><th>Outcome</th></tr></thead>
  <tbody>{{#each approvals}}<tr><td>{{stage}}</td><td>{{by}}</td><td>{{formatDate at "DD-MMM-YYYY HH:mm"}}</td><td>{{outcome}}</td></tr>{{/each}}</tbody>
</table>
{{/if}}

<div class="signoff">
  <div>{{qrCode document.url size=96}}<div class="qr-cap">Scan to open this PO</div></div>
  <div class="small muted">This is a computer-generated purchase order. Please quote the PO number on your invoice, delivery challan and all correspondence. Supply against this order confirms acceptance of the terms above.</div>
  <div class="sign">
    <div class="strong small">For {{tenant.legalName}}</div>
    <div class="space">{{#if document.images.signature}}<img src="{{document.images.signature}}" alt="">{{/if}}</div>
    <div class="line">Authorised Signatory</div>
  </div>
</div>
</div>`;

export const PO_FOOTER = pageFooter('Purchase Order');

/** Earlier shipped versions of PO_BODY: an installed starter still equal to one of these is unmodified and upgraded. */
export const PO_BODY_PREVIOUS: string[] = [
  PO_BODY.replace(PO_TOTALS_TAXABLE, PO_TOTALS_V1_TAXABLE).replace(PO_TOTALS_DISCOUNT_AFTER_TAX, PO_TOTALS_V1_DISCOUNT),
];

// ---------------------------------------------------------------------------------------------- Indent
export const INDENT_BODY = `${PRINT_CSS}
<div class="doc">
${DRAFT_WATERMARK}
${letterhead('Material Indent')}

<div class="facts">
  <div><div class="label">Indent number</div><div class="value">{{#if document.number}}{{document.number}}{{else}}Not submitted{{/if}}</div></div>
  <div><div class="label">Date</div><div class="value">{{formatDate document.docDate}}</div></div>
  <div><div class="label">Required by</div><div class="value">{{#if document.requiredBy}}{{formatDate document.requiredBy}}{{else}}–{{/if}}</div></div>
  <div><div class="label">Priority</div><div class="value">{{#if document.display.priority}}{{document.display.priority}}{{else}}Normal{{/if}}</div></div>
</div>

<div class="parties">
  <div class="box">
    <h3>Raised for</h3>
    <div class="name">{{document.location.name}}</div>
    <div class="kv">
      <span class="k">Location code</span><span>{{document.location.code}}</span>
      {{#if document.display.department}}<span class="k">Department</span><span>{{document.display.department}}</span>{{/if}}
      {{#if document.submittedBy}}<span class="k">Raised by</span><span>{{document.submittedBy.name}}</span>{{else}}{{#if document.createdBy}}<span class="k">Raised by</span><span>{{document.createdBy.name}}</span>{{/if}}{{/if}}
    </div>
  </div>
  <div class="box">
    <h3>Purpose</h3>
    <div class="tbody">{{#if document.display.purpose}}{{document.display.purpose}}{{else}}–{{/if}}</div>
  </div>
</div>

<table class="items">
  <thead>
    <tr>
      <th class="center" style="width:22px">#</th>
      <th style="width:80px">Item code</th>
      <th>Item description</th>
      <th class="num" style="width:70px">Qty</th>
      <th style="width:44px">Unit</th>
      <th style="width:80px">Required on</th>
      <th style="width:150px">Remarks</th>
    </tr>
  </thead>
  <tbody>
    {{#each lines}}
    <tr{{#if cancelled}} class="cancelled"{{/if}}>
      <td class="center">{{#if sr}}{{sr}}{{else}}–{{/if}}</td>
      <td class="nowrap">{{item.code}}</td>
      <td class="strong">{{item.name}}</td>
      <td class="num">{{formatNumber qty 2}}</td>
      <td>{{uom}}</td>
      <td class="nowrap">{{#if requiredDate}}{{formatDate requiredDate}}{{else}}{{formatDate ../document.requiredBy}}{{/if}}</td>
      <td>{{values.remarks}}</td>
    </tr>
    {{/each}}
  </tbody>
</table>

{{#if approvals.length}}
<div class="section-title">Approvals</div>
<table class="approvals">
  <thead><tr><th>Stage</th><th>By</th><th>On</th><th>Outcome</th><th>Remarks</th></tr></thead>
  <tbody>{{#each approvals}}<tr><td>{{stage}}</td><td>{{by}}</td><td>{{formatDate at "DD-MMM-YYYY HH:mm"}}</td><td>{{outcome}}</td><td>{{comment}}</td></tr>{{/each}}</tbody>
</table>
{{/if}}

<div class="sig-row">
  <div>Requested by<div class="small muted">{{#if document.submittedBy}}{{document.submittedBy.name}}{{/if}}</div></div>
  <div>Verified by</div>
  <div>Approved by</div>
</div>
<div class="signoff" style="grid-template-columns: 90px 1fr;">
  <div>{{qrCode document.url size=80}}</div>
  <div class="small muted">Computer-generated indent. Scan the code to open it online and see its current status.</div>
</div>
</div>`;

export const INDENT_FOOTER = pageFooter('Indent');

// ---------------------------------------------------------------------------------------------- Generic document
export const GENERIC_BODY = `${PRINT_CSS}
<div class="doc">
${DRAFT_WATERMARK}
${letterhead('{{document.docTypeName}}')}

<div class="facts">
  <div><div class="label">Number</div><div class="value">{{#if document.number}}{{document.number}}{{else}}Draft{{/if}}</div></div>
  <div><div class="label">Date</div><div class="value">{{formatDate document.docDate}}</div></div>
  <div><div class="label">Location</div><div class="value">{{document.location.name}}</div></div>
  <div><div class="label">Status</div><div class="value">{{document.statusLabel}}</div></div>
</div>

<div class="fields">
  {{#each document.fields}}
    {{#if value}}<div><div class="label">{{label}}</div><div class="value">{{value}}</div></div>{{/if}}
  {{/each}}
</div>

{{#if lines.length}}
<table class="items">
  <thead>
    <tr>
      <th class="center" style="width:22px">#</th>
      {{#each lineColumns}}<th{{#ifEq align "right"}} class="num"{{/ifEq}}>{{label}}</th>{{/each}}
    </tr>
  </thead>
  <tbody>
    {{#each lines}}
    <tr{{#if cancelled}} class="cancelled"{{/if}}>
      <td class="center">{{#if sr}}{{sr}}{{else}}–{{/if}}</td>
      {{#each cells}}<td{{#ifEq align "right"}} class="num"{{/ifEq}}>{{value}}</td>{{/each}}
    </tr>
    {{/each}}
  </tbody>
</table>
{{#ifEq totals.lineTotal "0.00"}}{{else}}
<div class="summary">
  <div class="words"><div class="label">Amount in words</div><div class="strong">{{amountInWords totals.grand document.currency}}</div></div>
  <table class="totals"><tr class="grand"><td>Total</td><td class="num">{{formatMoney totals.grand document.currency}}</td></tr></table>
</div>
{{/ifEq}}
{{/if}}

{{#if approvals.length}}
<div class="section-title">Approvals</div>
<table class="approvals">
  <thead><tr><th>Stage</th><th>By</th><th>On</th><th>Outcome</th><th>Remarks</th></tr></thead>
  <tbody>{{#each approvals}}<tr><td>{{stage}}</td><td>{{by}}</td><td>{{formatDate at "DD-MMM-YYYY HH:mm"}}</td><td>{{outcome}}</td><td>{{comment}}</td></tr>{{/each}}</tbody>
</table>
{{/if}}

<div class="signoff">
  <div>{{qrCode document.url size=88}}</div>
  <div class="small muted">Computer-generated document. Scan the code to open it online.</div>
  <div class="sign"><div class="space"></div><div class="line">Authorised Signatory</div></div>
</div>
</div>`;

export const GENERIC_FOOTER = pageFooter('{{document.docTypeName}}');

// ---------------------------------------------------------------------------------------------- Comparison sheet
/** Needs the `comparison` context extension (procurement): [{ itemName, qty, uom, lines[], vendors[], history[] }]. */
export const COMPARISON_BODY = `${PRINT_CSS}
<div class="doc">
${letterhead('Comparison Sheet')}
<div class="facts">
  <div><div class="label">Indent</div><div class="value">{{document.number}}</div></div>
  <div><div class="label">Date</div><div class="value">{{formatDate document.docDate}}</div></div>
  <div><div class="label">Location</div><div class="value">{{document.location.name}}</div></div>
  <div><div class="label">Printed</div><div class="value">{{formatDate app.generatedAt}}</div></div>
</div>
{{#each comparison}}
  <div class="section-title">{{itemName}} — {{formatNumber qty 2}} {{uom}}</div>
  <table class="items">
    <thead><tr><th>Vendor</th><th class="num">Quoted rate</th><th class="num">Effective rate</th><th class="num">Freight / unit</th><th class="num">Tax %</th>
      <th class="num">Landed / unit</th><th class="num">Landed total</th><th class="num">Lead time</th><th>Valid until</th><th>Notes</th></tr></thead>
    <tbody>
      {{#each vendors}}
      <tr>
        <td><span class="strong">{{vendor.name}}</span>{{#if isBest}} <span class="doc-badge">Best</span>{{/if}}<div class="sub">{{vendor.code}}{{#if paymentTerms}} · {{paymentTerms}}{{/if}}</div></td>
        <td class="num">{{formatNumber quotedRate 2}}</td><td class="num">{{formatNumber effectiveRate 2}}</td><td class="num">{{formatNumber freightPerUnit 2}}</td>
        <td class="num">{{taxPct}}</td><td class="num strong">{{formatNumber landedCostPerUnit 2}}</td><td class="num">{{formatMoney landedTotal}}</td>
        <td class="num">{{#if leadTimeDays}}{{leadTimeDays}} d{{/if}}</td><td>{{formatDate validUntil}}</td><td>{{#each warnings}}{{this}} {{/each}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>
{{else}}
  <p class="muted">No vendor quotes have been logged for this indent yet.</p>
{{/each}}
<div class="sig-row"><div>Prepared by</div><div>Checked by</div><div>Approved by</div></div>
</div>`;

// ---------------------------------------------------------------------------------------------- Email: PO approved
export const PO_EMAIL_SUBJECT = 'Purchase Order {{document.number}} from {{tenant.name}}';
export const PO_EMAIL_BODY = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2933;max-width:600px">
  <p>Dear {{#if recipient.name}}{{recipient.name}}{{else}}{{document.party.name}}{{/if}},</p>
  <p>Please find attached our Purchase Order <strong>{{document.number}}</strong> dated {{formatDate document.docDate}}.</p>
  <table style="border-collapse:collapse;margin:12px 0;font-size:14px">
    <tr><td style="padding:4px 16px 4px 0;color:#6b7785">PO number</td><td style="padding:4px 0"><strong>{{document.number}}</strong></td></tr>
    <tr><td style="padding:4px 16px 4px 0;color:#6b7785">Order value</td><td style="padding:4px 0"><strong>{{formatMoney totals.grand document.currency}}</strong></td></tr>
    {{#if document.values.expected_date}}<tr><td style="padding:4px 16px 4px 0;color:#6b7785">Expected delivery</td><td style="padding:4px 0">{{formatDate document.values.expected_date}}</td></tr>{{/if}}
    <tr><td style="padding:4px 16px 4px 0;color:#6b7785">Deliver to</td><td style="padding:4px 0">{{document.location.name}}</td></tr>
  </table>
  <p>Kindly acknowledge receipt and confirm the delivery schedule. Please quote the PO number on your invoice and delivery challan.</p>
  <p>Regards,<br>{{#if event.actor.name}}{{event.actor.name}}<br>{{/if}}{{tenant.legalName}}</p>
</div>`;

// ---------------------------------------------------------------------------------------------- In-app: approval pending
export const APPROVAL_PENDING_TITLE = '{{document.docTypeName}} {{document.number}} is waiting for your approval';
export const APPROVAL_PENDING_BODY = '{{#if event.actor.name}}{{event.actor.name}} submitted {{/if}}{{document.docTypeName}} {{document.number}}{{#if document.location.name}} for {{document.location.name}}{{/if}}{{#ifEq totals.grand "0.00"}}{{else}} ({{formatMoney totals.grand document.currency}}){{/ifEq}}. Please review it.';

// ---------------------------------------------------------------------------------------------- Debit note (RTV)
/** Phase 5 (GRN agent): return to vendor → debit note. Generic line columns (item, qty, rate, amount, batch, reason). */
export const RTV_DEBIT_NOTE_BODY = `${PRINT_CSS}
<div class="doc">
${DRAFT_WATERMARK}
${letterhead('Debit Note')}

<div class="facts">
  <div><div class="label">Debit note no.</div><div class="value">{{#if document.number}}{{document.number}}{{else}}Draft{{/if}}</div></div>
  <div><div class="label">Date</div><div class="value">{{formatDate document.docDate}}</div></div>
  <div><div class="label">Location</div><div class="value">{{document.location.name}}</div></div>
  <div><div class="label">Status</div><div class="value">{{document.statusLabel}}</div></div>
</div>

<div class="parties">
  <div class="box">
    <h3>To (supplier)</h3>
    {{#with document.party}}
      <div class="name">{{name}}</div>
      {{#if address}}<div class="tbody">{{address}}</div>{{/if}}
      <div class="kv">
        <span class="k">Vendor code</span><span>{{code}}</span>
        {{#if gstin}}<span class="k">GSTIN</span><span>{{gstin}}</span>{{/if}}
      </div>
    {{else}}
      <div class="muted">Supplier not selected</div>
    {{/with}}
  </div>
  <div class="box">
    <h3>From</h3>
    <div class="name">{{tenant.legalName}}</div>
    <div>{{document.location.name}} ({{document.location.code}})</div>
    {{#if tenant.gstin}}<div class="kv"><span class="k">GSTIN</span><span>{{tenant.gstin}}</span></div>{{/if}}
  </div>
</div>

{{#if document.values.reason}}<p><strong>Reason:</strong> {{document.values.reason}}</p>{{/if}}

<table class="items">
  <thead>
    <tr>
      <th class="center" style="width:22px">#</th>
      {{#each lineColumns}}<th{{#ifEq align "right"}} class="num"{{/ifEq}}>{{label}}</th>{{/each}}
    </tr>
  </thead>
  <tbody>
    {{#each lines}}
    <tr{{#if cancelled}} class="cancelled"{{/if}}>
      <td class="center">{{#if sr}}{{sr}}{{else}}–{{/if}}</td>
      {{#each cells}}<td{{#ifEq align "right"}} class="num"{{/ifEq}}>{{value}}</td>{{/each}}
    </tr>
    {{/each}}
  </tbody>
</table>
<div class="summary">
  <div class="words"><div class="label">Amount in words</div><div class="strong">{{amountInWords totals.grand document.currency}}</div></div>
  <table class="totals"><tr class="grand"><td>Debit amount</td><td class="num">{{formatMoney totals.grand document.currency}}</td></tr></table>
</div>
<p class="small muted">Please issue a credit note for the above material returned to you, or adjust it against your next invoice.</p>

<div class="signoff">
  <div>{{qrCode document.url size=88}}</div>
  <div class="small muted">Computer-generated document. Scan the code to open it online.</div>
  <div class="sign"><div class="space"></div><div class="line">Authorised Signatory</div></div>
</div>
</div>`;

export const RTV_DEBIT_NOTE_FOOTER = pageFooter('Debit Note');
