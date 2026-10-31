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
<style>
  /* ── Jeevaka PO extra styles ── */
  .jk-header { text-align: center; border-bottom: 2px solid #12355b; padding-bottom: 8px; margin-bottom: 10px; }
  .jk-header .co-name { font-size: 15pt; font-weight: 800; color: #12355b; letter-spacing: .5px; }
  .jk-header .co-sub  { font-size: 8pt; color: #4a5560; margin-top: 2px; }
  .jk-header .po-title { font-size: 13pt; font-weight: 700; letter-spacing: 2px; color: #12355b; text-transform: uppercase; margin-top: 5px; }
  .jk-grid2 { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid #ccc; border-collapse: collapse; margin-bottom: 10px; }
  .jk-grid2 table { width: 100%; border-collapse: collapse; }
  .jk-grid2 table td { padding: 3px 6px; border: 1px solid #ccc; font-size: 8.5pt; }
  .jk-grid2 table td:first-child { font-weight: 600; width: 48%; background: #f4f6f9; }
  .jk-grid2 .left-half  { border-right: 1px solid #ccc; }
  .jk-grid2 .right-half { }
  .jk-section-head { background: #12355b; color: #fff; font-weight: 700; font-size: 8pt; text-transform: uppercase; letter-spacing: .5px; padding: 4px 7px; border: 1px solid #12355b; }
  .jk-delto-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid #ccc; margin-bottom: 10px; }
  .jk-delto-grid .box-inner { padding: 0; }
  .jk-delto-grid table { width: 100%; border-collapse: collapse; }
  .jk-delto-grid table td { padding: 3px 6px; border: 1px solid #ccc; font-size: 8.5pt; }
  .jk-delto-grid table td:first-child { font-weight: 600; width: 45%; background: #f4f6f9; }
  .jk-delto-grid .left-half { border-right: 1px solid #ccc; }
  .jk-order-val { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid #ccc; margin-top: 8px; margin-bottom: 10px; }
  .jk-order-val table { width: 100%; border-collapse: collapse; }
  .jk-order-val table td { padding: 3px 6px; border: 1px solid #ccc; font-size: 8.5pt; }
  .jk-order-val table td:first-child { font-weight: 600; background: #f4f6f9; width: 55%; }
  .jk-order-val .right-half { border-left: 1px solid #ccc; }
  .jk-comm-terms { border: 1px solid #ccc; margin-bottom: 10px; }
  .jk-comm-terms .ct-grid { display: grid; grid-template-columns: 1fr 1fr; }
  .jk-comm-terms .ct-cell { border: 1px solid #ccc; padding: 0; }
  .jk-comm-terms .ct-cell table { width: 100%; border-collapse: collapse; }
  .jk-comm-terms .ct-cell table td { padding: 3px 6px; border: 0; font-size: 8.5pt; }
  .jk-comm-terms .ct-cell table td:first-child { font-weight: 600; width: 46%; background: #f4f6f9; border-right: 1px solid #eee; }
  .jk-comm-terms .ct-special td { font-size: 8.5pt; padding: 4px 6px; border-bottom: 1px solid #ccc; }
  .jk-int-approval { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid #ccc; margin-bottom: 10px; }
  .jk-int-approval .ap-cell { border-right: 1px solid #ccc; padding: 5px 7px; }
  .jk-int-approval .ap-cell:last-child { border-right: 0; }
  .jk-int-approval .ap-label { font-weight: 700; font-size: 8pt; text-align: center; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin-bottom: 3px; }
  .jk-int-approval .ap-row { font-size: 8pt; color: #6b7785; }
  .jk-int-approval .ap-name { font-size: 8pt; color: #1f2933; font-weight: 600; }
  .jk-int-approval .ap-space { height: 40px; }
  /* Page 2 T&C */
  .jk-tnc-title { font-size: 11pt; font-weight: 800; text-align: center; text-transform: uppercase; letter-spacing: 1px; color: #12355b; margin: 10px 0 2px; }
  .jk-tnc-sub   { font-size: 7.5pt; text-align: center; color: #6b7785; margin-bottom: 8px; font-style: italic; }
  .jk-tnc-grid  { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid #ccc; }
  .jk-tnc-grid .tc-cell { border: 1px solid #ddd; padding: 5px 7px; font-size: 7.8pt; page-break-inside: avoid; }
  .jk-tnc-grid .tc-cell strong { font-weight: 700; }
  .jk-supplier-ack { border: 1px solid #ccc; margin-top: 10px; }
  .jk-supplier-ack .ack-title { background: #12355b; color: #fff; font-weight: 700; font-size: 8pt; text-transform: uppercase; padding: 4px 7px; letter-spacing: .5px; }
  .jk-supplier-ack table { width: 100%; border-collapse: collapse; }
  .jk-supplier-ack table td { padding: 4px 7px; border: 1px solid #ccc; font-size: 8.5pt; }
  .jk-supplier-ack table td:first-child { font-weight: 600; width: 25%; background: #f4f6f9; }
  .jk-supplier-ack .note { font-size: 7pt; color: #6b7785; padding: 4px 7px; font-style: italic; }
</style>
<div class="doc">
${DRAFT_WATERMARK}

<!-- ═══════════════════════ HEADER ═══════════════════════ -->
<div class="jk-header">
  {{#if tenant.logoUrl}}<img style="max-height:48px;max-width:160px;margin-bottom:4px;" src="{{tenant.logoUrl}}" alt="">{{/if}}
  <div class="co-name">{{tenant.legalName}}</div>
  <div class="co-sub">Regd. Office: {{#if tenant.addressText}}{{tenant.addressText}}{{else}}—{{/if}}</div>
  <div class="co-sub">
    {{#if tenant.gstin}}<strong>GSTIN:</strong> {{tenant.gstin}}{{/if}}
    {{#if tenant.cin}}&nbsp;&nbsp;<strong>CIN:</strong> {{tenant.cin}}{{/if}}
  </div>
  <div class="po-title">Purchase Order</div>
  <div style="font-size:7.5pt;color:#6b7785;margin-top:2px;">{{document.statusLabel}}</div>
</div>

<!-- ═══════════════════════ SUPPLIER DETAILS + ORDER DETAILS ═══════════════════════ -->
<div class="jk-grid2">
  <div class="left-half">
    <div class="jk-section-head">Supplier Details</div>
    <table>
      <tr><td>Supplier Code</td><td>{{#if document.party.code}}{{document.party.code}}{{else}}—{{/if}}</td></tr>
      <tr><td>Supplier Name</td><td>{{#if document.party.name}}<strong>{{document.party.name}}</strong>{{else}}—{{/if}}</td></tr>
      <tr><td>Address</td><td>{{#if document.party.address}}{{document.party.address}}{{else}}—{{/if}}</td></tr>
      <tr><td>State</td><td>{{#if document.party.state}}{{document.party.state}}{{else}}—{{/if}}</td></tr>
      <tr><td>GSTIN</td><td>{{#if document.party.gstin}}{{document.party.gstin}}{{else}}—{{/if}}</td></tr>
      <tr><td>Contact Person</td><td>{{#if document.party.contactPerson}}{{document.party.contactPerson}}{{else}}—{{/if}}</td></tr>
      <tr><td>Mobile / Email</td><td>{{#if document.party.phone}}{{document.party.phone}}{{/if}}{{#if document.party.email}} / {{document.party.email}}{{/if}}{{#unless document.party.phone}}{{#unless document.party.email}}—{{/unless}}{{/unless}}</td></tr>
    </table>
  </div>
  <div class="right-half">
    <div class="jk-section-head">Order Details</div>
    <table>
      <tr><td>PO No.</td><td><strong>{{#if document.number}}{{document.number}}{{else}}—{{/if}}</strong></td></tr>
      <tr><td>PO Date</td><td>{{formatDate document.docDate}}</td></tr>
      <tr><td>Amendment No.</td><td>{{#if document.revNo}}{{document.revNo}}{{else}}—{{/if}}</td></tr>
      <tr><td>Amendment Date</td><td>{{#if document.amendmentDate}}{{formatDate document.amendmentDate}}{{else}}—{{/if}}</td></tr>
      <tr><td>Supplier Quotation / Ref. No.</td><td>{{#if document.values.supplier_ref_no}}{{document.values.supplier_ref_no}}{{else}}—{{/if}}</td></tr>
      <tr><td>Quotation / Ref. Date</td><td>{{#if document.values.supplier_ref_date}}{{formatDate document.values.supplier_ref_date}}{{else}}—{{/if}}</td></tr>
      <tr><td>PR / Indent No.</td><td>{{#if document.values.indent_ref}}{{document.values.indent_ref}}{{else}}—{{/if}}</td></tr>
    </table>
  </div>
</div>

<!-- ═══════════════════════ DELIVER TO + BILL TO ═══════════════════════ -->
<div class="jk-delto-grid">
  <div class="left-half">
    <div class="jk-section-head">Deliver To</div>
    <table>
      <tr><td>Entity / Plant</td><td><strong>{{tenant.legalName}}</strong></td></tr>
      <tr><td>Division / Unit</td><td>{{document.location.name}} ({{document.location.code}})</td></tr>
      <tr><td>Address</td><td>{{#if tenant.addressText}}{{tenant.addressText}}{{else}}—{{/if}}</td></tr>
      <tr><td>State</td><td>{{#if document.location.values.state_code}}{{document.location.values.state_code}}{{else}}{{#if tenant.stateCode}}{{tenant.stateCode}}{{else}}—{{/if}}{{/if}}</td></tr>
      <tr><td>GSTIN</td><td>{{#if tenant.gstin}}{{tenant.gstin}}{{else}}—{{/if}}</td></tr>
    </table>
  </div>
  <div class="right-half">
    <div class="jk-section-head">Bill To</div>
    <table>
      <tr><td>Billing Entity</td><td><strong>{{tenant.legalName}}</strong></td></tr>
      <tr><td>Division / Unit</td><td>{{document.location.name}}</td></tr>
      <tr><td>Billing Address</td><td>{{#if tenant.addressText}}{{tenant.addressText}}{{else}}—{{/if}}</td></tr>
      <tr><td>GSTIN *</td><td>{{#if tenant.gstin}}{{tenant.gstin}}{{else}}—{{/if}}</td></tr>
      <tr><td>CIN *</td><td>{{#if tenant.cin}}{{tenant.cin}}{{else}}—{{/if}}</td></tr>
    </table>
  </div>
</div>

<!-- ═══════════════════════ ITEM / SERVICE SCHEDULE ═══════════════════════ -->
<div class="jk-section-head">Item / Service Schedule</div>
<table class="items">
  <thead>
    <tr>
      <th class="center" style="width:22px">Sr.</th>
      <th style="width:60px">Item Code</th>
      <th>Description / Specification / Make / Grade</th>
      <th style="width:52px">HSN / SAC</th>
      <th class="num" style="width:52px">Qty</th>
      <th style="width:34px">UOM</th>
      <th class="num" style="width:66px">Unit Rate</th>
      {{#if totals.hasTax}}
        <th class="num" style="width:66px">Taxable</th>
        {{#if totals.isInterState}}<th class="num" style="width:64px">IGST</th>{{else}}<th class="num" style="width:56px">CGST</th><th class="num" style="width:56px">SGST</th>{{/if}}
      {{/if}}
      <th class="num" style="width:72px">Amount</th>
    </tr>
  </thead>
  <tbody>
    {{#each lines}}
    <tr{{#if cancelled}} class="cancelled"{{/if}}>
      <td class="center">{{#if sr}}{{sr}}{{else}}–{{/if}}</td>
      <td class="nowrap">{{item.code}}</td>
      <td>
        <div class="strong">{{#if item}}{{item.name}}{{else}}{{display.description}}{{/if}}</div>
        {{#if values.remarks}}<div class="sub">{{values.remarks}}</div>{{/if}}
        {{#if values.expected_date}}<div class="sub">Due {{formatDate values.expected_date}}</div>{{/if}}
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

<!-- ═══════════════════════ ORDER VALUE ═══════════════════════ -->
<div class="jk-section-head" style="margin-top:8px;">Order Value</div>
<div class="jk-order-val">
  <div class="left-half">
    <table>
      <tr><td>Basic / Material Value</td><td class="num">{{formatMoney totals.taxable document.currency}}</td></tr>
      {{#ifEq totals.freight "0.00"}}{{else}}<tr><td>Freight</td><td class="num">{{formatMoney totals.freight document.currency}}</td></tr>{{/ifEq}}
      {{#ifEq totals.otherCharges "0.00"}}{{else}}<tr><td>Additional Charges</td><td class="num">{{formatMoney totals.otherCharges document.currency}}</td></tr>{{/ifEq}}
      <tr style="font-weight:700;border-top:2px solid #12355b;"><td>Total Order Value</td><td class="num">{{formatMoney totals.grand document.currency}}</td></tr>
    </table>
  </div>
  <div class="right-half">
    <table>
      <tr><td>Order Value in Words</td><td><strong>{{amountInWords totals.grand document.currency}}</strong></td></tr>
      {{#if totals.hasTax}}
        {{#if totals.isInterState}}
          <tr><td>IGST</td><td class="num">{{formatMoney totals.igst document.currency}}</td></tr>
        {{else}}
          <tr><td>CGST</td><td class="num">{{formatMoney totals.cgst document.currency}}</td></tr>
          <tr><td>SGST</td><td class="num">{{formatMoney totals.sgst document.currency}}</td></tr>
        {{/if}}
      {{/if}}
    </table>
  </div>
</div>

<!-- ═══════════════════════ COMMERCIAL TERMS ═══════════════════════ -->
<div class="jk-section-head" style="margin-top:8px;">Commercial Terms</div>
<div class="jk-comm-terms">
  <div class="ct-grid">
    <div class="ct-cell">
      <table><tr><td>Price Basis / Rate Validity</td><td>{{#if document.values.price_basis}}{{document.values.price_basis}}{{else}}—{{/if}}</td></tr></table>
    </div>
    <div class="ct-cell">
      <table><tr><td>Taxes / Duties / TDS</td><td>As applicable</td></tr></table>
    </div>
    <div class="ct-cell">
      <table><tr><td>Payment Terms / Mode / Credit Period</td><td>{{#if document.display.payment_terms}}{{document.display.payment_terms}}{{else}}{{#if document.party.paymentTerms}}{{document.party.paymentTerms}}{{else}}As agreed{{/if}}{{/if}}</td></tr></table>
    </div>
    <div class="ct-cell">
      <table><tr><td>Freight / Transport / Transit Insurance</td><td>{{#if document.values.freight_terms}}{{document.values.freight_terms}}{{else}}—{{/if}}</td></tr></table>
    </div>
    <div class="ct-cell">
      <table><tr><td>Delivery Schedule / Terms</td><td>{{#if document.values.expected_date}}{{formatDate document.values.expected_date}}{{else}}As per schedule{{/if}}</td></tr></table>
    </div>
    <div class="ct-cell">
      <table><tr><td>Packing &amp; Forwarding / Marking</td><td>{{#if document.values.packing_terms}}{{document.values.packing_terms}}{{else}}—{{/if}}</td></tr></table>
    </div>
    <div class="ct-cell">
      <table><tr><td>Quantity Tolerance (if applicable)</td><td>{{#if document.values.qty_tolerance}}{{document.values.qty_tolerance}}{{else}}—{{/if}}</td></tr></table>
    </div>
    <div class="ct-cell">
      <table><tr><td>Inspection / Test Certificates (if applicable)</td><td>{{#if document.values.inspection_terms}}{{document.values.inspection_terms}}{{else}}—{{/if}}</td></tr></table>
    </div>
    <div class="ct-cell">
      <table><tr><td>Warranty / Guarantee (if applicable)</td><td>{{#if document.values.warranty_terms}}{{document.values.warranty_terms}}{{else}}—{{/if}}</td></tr></table>
    </div>
    <div class="ct-cell">
      <table><tr><td>Installation / Commissioning / Site Services (if applicable)</td><td>{{#if document.values.installation_terms}}{{document.values.installation_terms}}{{else}}—{{/if}}</td></tr></table>
    </div>
    <div class="ct-cell">
      <table><tr><td>LD / Penalty (if applicable)</td><td>{{#if document.values.ld_terms}}{{document.values.ld_terms}}{{else}}—{{/if}}</td></tr></table>
    </div>
    <div class="ct-cell">
      <table><tr><td>BG / PBG / Retention (if applicable)</td><td>{{#if document.values.bg_terms}}{{document.values.bg_terms}}{{else}}—{{/if}}</td></tr></table>
    </div>
  </div>
  <table class="ct-special" style="width:100%;border-collapse:collapse;">
    <tr class="ct-special"><td style="font-weight:600;width:22%;background:#f4f6f9;border:1px solid #ccc;">Special Instructions / Annexure / Reference</td><td style="border:1px solid #ccc;">{{#if document.values.special_instructions}}{{document.values.special_instructions}}{{else}}&nbsp;{{/if}}</td></tr>
  </table>
</div>

<!-- ═══════════════════════ INTERNAL APPROVAL ═══════════════════════ -->
<div class="jk-section-head" style="margin-top:8px;">Internal Approval</div>
<div class="jk-int-approval">
  <div class="ap-cell">
    <div class="ap-label">Prepared By</div>
    <div class="ap-space"></div>
    <div class="ap-row">Name / Date / Signature</div>
  </div>
  <div class="ap-cell">
    <div class="ap-label">Verified / Checked By</div>
    <div class="ap-space"></div>
    <div class="ap-row">Name / Date / Signature</div>
  </div>
  <div class="ap-cell">
    <div class="ap-label">Approved By</div>
    {{#each approvals}}<div class="ap-name">{{by}}</div><div class="ap-row">{{formatDate at "DD-MMM-YYYY"}}</div>{{/each}}
    <div class="ap-space"></div>
    <div class="ap-row">Name / Date / Signature</div>
  </div>
  <div class="ap-cell">
    <div class="ap-label">Authorised Signatory</div>
    <div class="ap-space">{{#if document.images.signature}}<img src="{{document.images.signature}}" alt="" style="max-height:40px;">{{/if}}</div>
    <div class="ap-row">For {{tenant.legalName}}</div>
  </div>
</div>

<div style="text-align:right;font-size:7pt;color:#6b7785;margin-bottom:4px;">{{qrCode document.url size=64}} <span style="display:inline-block;vertical-align:top;padding-top:8px;margin-left:4px;">Scan to open this PO</span></div>

<!-- ═══════════════════════ PAGE 2: T&C + SUPPLIER ACKNOWLEDGEMENT ═══════════════════════ -->
<div style="page-break-before: always;">
<div class="jk-tnc-title">Standard Purchase Order Terms &amp; Conditions</div>
<div class="jk-tnc-sub">Applicable together with the PO, commercial terms and referenced specification / annexure</div>
<div class="jk-tnc-grid">
  <div class="tc-cell"><strong>1. Scope &amp; Conformity:</strong> Goods/services shall conform to the description, quantity, specification, approved sample/drawing and referenced annexures forming part of the PO.</div>
  <div class="tc-cell"><strong>9. Invoices &amp; Dispatch Documents:</strong> Invoices and delivery challans shall quote the PO number and applicable GST/HSN-SAC details. E-invoice, e-way bill, packing list, LR/transport document and certificates shall be submitted where legally or contractually applicable.</div>
  <div class="tc-cell"><strong>2. Order Acceptance &amp; Amendment:</strong> Supplier shall acknowledge the PO within the agreed period. Any change to price, quantity, specification, delivery or other terms is valid only through written approval / PO amendment by the Buyer.</div>
  <div class="tc-cell"><strong>10. Payment &amp; Deductions:</strong> Payment shall be released as per the commercial terms after receipt of acceptable goods/services and complete documents. Statutory deductions including TDS shall be made as applicable.</div>
  <div class="tc-cell"><strong>3. Order of Precedence:</strong> The PO and its written amendments shall prevail over conflicting supplier quotations, acknowledgements or correspondence unless a deviation is expressly accepted in writing by the Buyer.</div>
  <div class="tc-cell"><strong>11. Warranty / Service Obligation:</strong> Where warranty/guarantee is stated in the PO, supplier shall repair, replace or rectify covered defects within the agreed period without additional cost to Buyer, subject to the agreed scope.</div>
  <div class="tc-cell"><strong>4. Delivery:</strong> Time is of the essence. Supply shall be made as per the delivery schedule stated in the PO. Partial or early delivery requires Buyer approval where applicable.</div>
  <div class="tc-cell"><strong>12. Statutory, Safety &amp; Site Compliance:</strong> Supplier shall comply with applicable laws, taxes, labour requirements, safety/EHS rules, PPE requirements and MSDS obligations relevant to the supply/service.</div>
  <div class="tc-cell"><strong>5. Quality, Inspection &amp; Certificates:</strong> Buyer may inspect or test goods at supplier works or on receipt. Required test certificates / COA / MTC / guarantee certificates shall accompany the supply where specified.</div>
  <div class="tc-cell"><strong>13. Cancellation:</strong> Buyer may cancel the PO in whole or part for material breach, persistent delay, non-conforming supply or failure to comply with agreed terms, subject to applicable contractual/legal requirements.</div>
  <div class="tc-cell"><strong>6. Packing &amp; Transit Responsibility:</strong> Goods shall be suitably packed and identified for safe handling and transit. Loss or damage attributable to inadequate packing or handling shall be to supplier account.</div>
  <div class="tc-cell"><strong>14. Force Majeure:</strong> A party prevented from performance by events beyond reasonable control shall promptly notify the other party and take reasonable steps to mitigate delay. Continuing events may be handled as mutually agreed in writing.</div>
  <div class="tc-cell"><strong>7. Rejection &amp; Replacement:</strong> Non-conforming, damaged or short-supplied material may be rejected. Supplier shall remove and replace/rectify such material at its cost within the period communicated by Buyer.</div>
  <div class="tc-cell"><strong>15. Confidentiality:</strong> Technical, commercial and business information exchanged for the PO shall be kept confidential and used only for performance of the order, unless disclosure is required by law.</div>
  <div class="tc-cell"><strong>8. Risk Purchase / Alternate Procurement:</strong> If supplier fails to deliver or replace within the agreed period, Buyer may procure the balance from another source and recover reasonable additional cost from the defaulting supplier, subject to PO terms.</div>
  <div class="tc-cell"><strong>16. Dispute Resolution / Jurisdiction:</strong> Governing law, arbitration mechanism and courts having jurisdiction shall be as approved by {{tenant.legalName}} management/legal before issue of the final standard PO.</div>
</div>

<div class="jk-supplier-ack" style="margin-top:14px;">
  <div class="ack-title">Supplier Acknowledgement</div>
  <table>
    <tr><td>Supplier Name</td><td></td><td style="font-weight:600;width:25%;background:#f4f6f9;">Authorised Signatory</td><td></td></tr>
    <tr><td>Name / Designation</td><td></td><td style="font-weight:600;background:#f4f6f9;">Date / Seal</td><td></td></tr>
  </table>
  <div class="note">* Mandatory field in the final company format. Legal wording / approval hierarchy to be confirmed before company-wide release.</div>
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
