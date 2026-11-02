import { pageFooter } from './styles';

/**
 * Jeevaka Industries Private Limited — Purchase Order PDF template.
 * Matches the official Jeevaka PO format exactly:
 *   Page 1 : Company header · Supplier & Order details · Deliver to / Bill to ·
 *             Item/Service Schedule table · Order Value · Commercial Terms · Internal Approval
 *   Page 2 : Standard Purchase Order Terms & Conditions (16 clauses) · Supplier Acknowledgement
 */
export const JEEVAKA_PO_FOOTER = pageFooter('Purchase Order');

export const JEEVAKA_PO_BODY = `
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Inter', 'DejaVu Sans', 'Helvetica Neue', Arial, sans-serif;
    font-size: 8.5pt;
    line-height: 1.3;
    color: #1f1f1f;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .page { padding: 14px 14px 10px 14px; }
  .page2 { padding: 14px 14px 10px 14px; page-break-before: always; }

  /* Company header */
  .co-header { text-align: center; margin-bottom: 6px; }
  .co-name { font-size: 13pt; font-weight: 700; text-transform: uppercase; color: #1f1f1f; }
  .co-sub { font-size: 8pt; margin-top: 2px; }
  .co-doc-title { font-size: 12pt; font-weight: 700; text-transform: uppercase; border: 2px solid #1f1f1f; display: inline-block; padding: 1px 20px; margin-top: 4px; }

  /* All bordered tables */
  table.grid { width: 100%; border-collapse: collapse; margin-top: 4px; }
  table.grid th, table.grid td { border: 1px solid #1f1f1f; padding: 3px 5px; font-size: 7.8pt; vertical-align: top; }
  table.grid thead tr th { background: #1f1f1f; color: #fff; font-weight: 600; text-align: center; font-size: 7.5pt; text-transform: uppercase; }

  /* Section title bars */
  .sec-title { background: #1f1f1f; color: #fff; font-weight: 600; font-size: 7.8pt; text-transform: uppercase; padding: 3px 5px; margin-top: 4px; }

  /* Label cells */
  .lbl { color: #1f1f1f; font-weight: 400; }
  .val { font-weight: 400; }

  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .center { text-align: center; }
  .strong { font-weight: 700; }
  .small { font-size: 7pt; }

  /* Approval table at bottom of page 1 */
  .approval-table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  .approval-table th, .approval-table td { border: 1px solid #1f1f1f; padding: 3px 5px; font-size: 7.8pt; vertical-align: top; }
  .approval-table thead tr th { background: #1f1f1f; color: #fff; font-weight: 600; text-align: center; font-size: 7.5pt; text-transform: uppercase; }
  .approval-table td { height: 32px; }

  /* Page 2 - T&C */
  .tc-title { text-align: center; font-size: 11pt; font-weight: 700; text-transform: uppercase; margin-bottom: 2px; }
  .tc-sub { text-align: center; font-style: italic; font-size: 7.5pt; margin-bottom: 6px; }
  table.tc-table { width: 100%; border-collapse: collapse; }
  table.tc-table td { border: 1px solid #1f1f1f; padding: 5px 7px; font-size: 7.5pt; vertical-align: top; width: 50%; }
  table.tc-table td b { font-weight: 700; }

  /* Supplier acknowledgement */
  .ack-title { font-size: 8.5pt; font-weight: 700; text-transform: uppercase; margin-top: 8px; margin-bottom: 2px; }
  table.ack-table { width: 100%; border-collapse: collapse; }
  table.ack-table td { border: 1px solid #1f1f1f; padding: 3px 5px; font-size: 7.5pt; vertical-align: top; }
  table.ack-table td.ack-label { width: 25%; }
  table.ack-table td.ack-val { width: 25%; }
  .mandatory-note { font-size: 7pt; font-style: italic; text-align: center; margin-top: 4px; }

  .watermark { position: fixed; top: 38%; left: 5%; font-size: 90pt; color: rgba(200,30,30,.08); transform: rotate(-24deg); pointer-events: none; }
</style>

<!-- ======== PAGE 1 ======== -->
<div class="page">
  {{#if document.isDraft}}<div class="watermark">DRAFT</div>{{/if}}

  <!-- Company header -->
  <div class="co-header">
    <div class="co-name">Jeevaka Industries Private Limited</div>
    <div class="co-sub">Regd. Office: 15-9-360, Mahaboobgunj, Hyderabad - 500 012</div>
    <div class="co-sub">GSTIN: {{tenant.gstin}}&nbsp;&nbsp;|&nbsp;&nbsp;CIN*: U27100TG1996PTC023288</div>
    <div><span class="co-doc-title">PURCHASE ORDER</span></div>
  </div>

  <!-- Supplier Details + Order Details (two-column header) -->
  <table class="grid" style="margin-top:6px;">
    <thead>
      <tr>
        <th colspan="2" style="width:50%">SUPPLIER DETAILS</th>
        <th colspan="2" style="width:50%">ORDER DETAILS</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="lbl" style="width:25%">Supplier Code</td>
        <td class="val" style="width:25%">{{document.party.code}}</td>
        <td class="lbl" style="width:25%">PO No.</td>
        <td class="val" style="width:25%">{{#if document.number}}{{document.number}}{{/if}}{{#if document.revNo}} &middot; Rev {{document.revNo}}{{/if}}</td>
      </tr>
      <tr>
        <td class="lbl">Supplier Name</td>
        <td class="val">{{document.party.name}}</td>
        <td class="lbl">PO Date</td>
        <td class="val">{{formatDate document.docDate}}</td>
      </tr>
      <tr>
        <td class="lbl">Address</td>
        <td class="val">{{document.party.address}}</td>
        <td class="lbl">Amendment No.</td>
        <td class="val">{{#if document.revNo}}{{document.revNo}}{{/if}}</td>
      </tr>
      <tr>
        <td class="lbl">State</td>
        <td class="val">{{document.party.state_code}}</td>
        <td class="lbl">Amendment Date</td>
        <td class="val">{{#if document.revNo}}{{formatDate document.docDate}}{{/if}}</td>
      </tr>
      <tr>
        <td class="lbl">GSTIN</td>
        <td class="val">{{document.party.gstin}}</td>
        <td class="lbl">Supplier Quotation / Ref. No.</td>
        <td class="val">{{document.display.supplier_ref}}</td>
      </tr>
      <tr>
        <td class="lbl">Contact Person</td>
        <td class="val">{{document.party.values.contact_person}}</td>
        <td class="lbl">Quotation / Ref. Date</td>
        <td class="val">{{#if document.values.supplier_ref_date}}{{formatDate document.values.supplier_ref_date}}{{/if}}</td>
      </tr>
      <tr>
        <td class="lbl">Mobile / Email</td>
        <td class="val">{{document.party.phone}}{{#if document.party.phone}}{{#if document.party.email}} / {{/if}}{{/if}}{{document.party.email}}</td>
        <td class="lbl">PR / Indent No.</td>
        <td class="val">{{document.display.indent_ref}}</td>
      </tr>
    </tbody>
  </table>

  <!-- Deliver To / Bill To -->
  <table class="grid" style="margin-top:4px;">
    <thead>
      <tr>
        <th colspan="2" style="width:50%">DELIVER TO</th>
        <th colspan="2" style="width:50%">BILL TO</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="lbl" style="width:18%">Entity / Plant</td>
        <td class="val" style="width:32%">{{tenant.legalName}}</td>
        <td class="lbl" style="width:18%">Billing Entity</td>
        <td class="val" style="width:32%">{{tenant.legalName}}</td>
      </tr>
      <tr>
        <td class="lbl">Division / Unit</td>
        <td class="val">{{document.location.name}}</td>
        <td class="lbl">Division / Unit</td>
        <td class="val">{{document.location.name}}</td>
      </tr>
      <tr>
        <td class="lbl">Address</td>
        <td class="val">{{tenant.addressText}}</td>
        <td class="lbl">Billing Address</td>
        <td class="val">{{tenant.addressText}}</td>
      </tr>
      <tr>
        <td class="lbl">State</td>
        <td class="val">{{#if document.location.values.state_code}}{{document.location.values.state_code}}{{else}}{{tenant.address.state}}{{/if}}</td>
        <td class="lbl">GSTIN *</td>
        <td class="val">{{tenant.gstin}}</td>
      </tr>
      <tr>
        <td class="lbl">GSTIN</td>
        <td class="val">{{tenant.gstin}}</td>
        <td class="lbl">CIN *</td>
        <td class="val">U27100TG1996PTC023288</td>
      </tr>
    </tbody>
  </table>

  <!-- Item / Service Schedule -->
  <div class="sec-title" style="margin-top:6px;">ITEM / SERVICE SCHEDULE</div>
  <table class="grid" style="margin-top:0;">
    <thead>
      <tr>
        <th style="width:22px">Sr.</th>
        <th style="width:60px">Item Code</th>
        <th>Description / Specification / Make / Grade</th>
        <th style="width:52px">HSN / SAC</th>
        <th class="num" style="width:44px">Qty</th>
        <th style="width:34px">UOM</th>
        <th class="num" style="width:60px">Unit Rate</th>
        <th class="num" style="width:70px">Amount</th>
      </tr>
    </thead>
    <tbody>
      {{#each lines}}
      <tr{{#if cancelled}} style="text-decoration:line-through;color:#888;"{{/if}}>
        <td class="center">{{#if sr}}{{sr}}{{else}}-{{/if}}</td>
        <td>{{#if item}}{{item.code}}{{/if}}</td>
        <td>
          <span class="strong">{{#if item}}{{item.name}}{{else}}{{display.description}}{{/if}}</span>
          {{#if values.remarks}}<div class="small">{{values.remarks}}</div>{{/if}}
        </td>
        <td class="center">{{item.hsn}}</td>
        <td class="num">{{formatNumber qty 2}}</td>
        <td>{{uom}}</td>
        <td class="num">{{formatNumber rate 2}}</td>
        <td class="num">{{#if ../totals.hasTax}}{{formatNumber total 2}}{{else}}{{formatNumber amount 2}}{{/if}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>

  <!-- Order Value -->
  <div class="sec-title" style="margin-top:6px;">ORDER VALUE</div>
  <table class="grid" style="margin-top:0;">
    <tbody>
      <tr>
        <td class="lbl" style="width:25%">Basic / Material Value</td>
        <td class="val num" style="width:25%">{{formatMoney totals.taxable document.currency}}</td>
        <td class="lbl" style="width:25%">Additional Charges, if any</td>
        <td class="val num" style="width:25%">{{#ifEq totals.otherCharges "0.00"}}{{else}}{{formatMoney totals.otherCharges document.currency}}{{/ifEq}}</td>
      </tr>
      <tr>
        <td class="lbl strong">Total Order Value</td>
        <td class="val num strong">{{formatMoney totals.grand document.currency}}</td>
        <td class="lbl">Order Value in Words</td>
        <td class="val">{{amountInWords totals.grand document.currency}}</td>
      </tr>
    </tbody>
  </table>

  <!-- Commercial Terms -->
  <div class="sec-title" style="margin-top:6px;">COMMERCIAL TERMS</div>
  <table class="grid" style="margin-top:0;">
    <tbody>
      <tr>
        <td class="lbl" style="width:25%">Price Basis / Rate Validity</td>
        <td class="val" style="width:25%">{{document.display.price_basis}}</td>
        <td class="lbl" style="width:25%">Taxes / Duties / TDS</td>
        <td class="val" style="width:25%">{{#if document.display.tax_terms}}{{document.display.tax_terms}}{{else}}As applicable{{/if}}</td>
      </tr>
      <tr>
        <td class="lbl">Payment Terms / Mode / Credit Period</td>
        <td class="val">{{#if document.display.payment_terms}}{{document.display.payment_terms}}{{else}}{{document.party.paymentTerms}}{{/if}}</td>
        <td class="lbl">Freight / Transport / Transit Insurance</td>
        <td class="val">{{document.display.freight_terms}}</td>
      </tr>
      <tr>
        <td class="lbl">Delivery Schedule / Terms</td>
        <td class="val">{{#if document.values.expected_date}}{{formatDate document.values.expected_date}}{{else}}{{document.display.delivery_terms}}{{/if}}</td>
        <td class="lbl">Packing &amp; Forwarding / Marking</td>
        <td class="val">{{document.display.packing_terms}}</td>
      </tr>
      <tr>
        <td class="lbl">Quantity Tolerance (if applicable)</td>
        <td class="val">{{document.display.qty_tolerance}}</td>
        <td class="lbl">Inspection / Test Certificates (if applicable)</td>
        <td class="val">{{document.display.inspection_terms}}</td>
      </tr>
      <tr>
        <td class="lbl">Warranty / Guarantee (if applicable)</td>
        <td class="val">{{document.display.warranty_terms}}</td>
        <td class="lbl">Installation / Commissioning / Site Services (if applicable)</td>
        <td class="val">{{document.display.installation_terms}}</td>
      </tr>
      <tr>
        <td class="lbl">LD / Penalty (if applicable)</td>
        <td class="val">{{document.display.ld_terms}}</td>
        <td class="lbl">BG / PBG / Retention (if applicable)</td>
        <td class="val">{{document.display.bg_terms}}</td>
      </tr>
      <tr>
        <td class="lbl" colspan="4" style="padding-bottom:20px;">Special Instructions / Annexure / Reference&nbsp;&nbsp;{{document.display.special_instructions}}</td>
      </tr>
    </tbody>
  </table>

  <!-- Internal Approval -->
  <div class="sec-title" style="margin-top:6px;">INTERNAL APPROVAL</div>
  <table class="approval-table" style="margin-top:0;">
    <thead>
      <tr>
        <th style="width:25%">Prepared By</th>
        <th style="width:25%">Verified / Checked By</th>
        <th style="width:25%">Approved By</th>
        <th style="width:25%">Authorised Signatory</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="height:42px;">
          {{#if document.createdBy}}<div class="small">{{document.createdBy.name}}</div>{{/if}}
          <div class="small" style="margin-top:28px;border-top:1px solid #aaa;padding-top:2px;">Name / Date / Signature</div>
        </td>
        <td style="height:42px;">
          {{#each approvals}}{{#ifEq stageKey "checker"}}<div class="small">{{by}} &middot; {{formatDate at}}</div>{{/ifEq}}{{/each}}
          <div class="small" style="margin-top:28px;border-top:1px solid #aaa;padding-top:2px;">Name / Date / Signature</div>
        </td>
        <td style="height:42px;">
          {{#each approvals}}{{#ifEq stageKey "approver"}}<div class="small">{{by}} &middot; {{formatDate at}}</div>{{/ifEq}}{{/each}}
          <div class="small" style="margin-top:28px;border-top:1px solid #aaa;padding-top:2px;">Name / Date / Signature</div>
        </td>
        <td style="height:42px;">
          <div>{{#if document.images.signature}}<img src="{{document.images.signature}}" alt="" style="max-height:32px;max-width:100px;">{{/if}}</div>
          <div class="small" style="margin-top:4px;border-top:1px solid #aaa;padding-top:2px;">Name / Date / Signature</div>
        </td>
      </tr>
    </tbody>
  </table>
</div>

<!-- ======== PAGE 2 - Standard T&C + Supplier Acknowledgement ======== -->
<div class="page2">
  <div class="tc-title">STANDARD PURCHASE ORDER TERMS &amp; CONDITIONS</div>
  <div class="tc-sub">Applicable together with the PO, commercial terms and referenced specification / annexure</div>

  <table class="tc-table">
    <tbody>
      <tr>
        <td><b>1. Scope &amp; Conformity:</b> Goods/services shall conform to the description, quantity, specification, approved sample/drawing and referenced annexures forming part of the PO.</td>
        <td><b>9. Invoices &amp; Dispatch Documents:</b> Invoices and delivery challans shall quote the PO number and applicable GST/HSN-SAC details. E-invoice, e-way bill, packing list, LR/transport document and certificates shall be submitted where legally or contractually applicable.</td>
      </tr>
      <tr>
        <td><b>2. Order Acceptance &amp; Amendment:</b> Supplier shall acknowledge the PO within the agreed period. Any change to price, quantity, specification, delivery or other terms is valid only through written approval / PO amendment by the Buyer.</td>
        <td><b>10. Payment &amp; Deductions:</b> Payment shall be released as per the commercial terms after receipt of acceptable goods/services and complete documents. Statutory deductions including TDS shall be made as applicable.</td>
      </tr>
      <tr>
        <td><b>3. Order of Precedence:</b> The PO and its written amendments shall prevail over conflicting supplier quotations, acknowledgements or correspondence unless a deviation is expressly accepted in writing by the Buyer.</td>
        <td><b>11. Warranty / Service Obligation:</b> Where warranty/guarantee is stated in the PO, supplier shall repair, replace or rectify covered defects within the agreed period without additional cost to Buyer, subject to the agreed scope.</td>
      </tr>
      <tr>
        <td><b>4. Delivery:</b> Time is of the essence. Supply shall be made as per the delivery schedule stated in the PO. Partial or early delivery requires Buyer approval where applicable.</td>
        <td><b>12. Statutory, Safety &amp; Site Compliance:</b> Supplier shall comply with applicable laws, taxes, labour requirements, safety/EHS rules, PPE requirements and MSDS obligations relevant to the supply/service.</td>
      </tr>
      <tr>
        <td><b>5. Quality, Inspection &amp; Certificates:</b> Buyer may inspect or test goods at supplier works or on receipt. Required test certificates / COA / MTC / guarantee certificates shall accompany the supply where specified.</td>
        <td><b>13. Cancellation:</b> Buyer may cancel the PO in whole or part for material breach, persistent delay, non-conforming supply or failure to comply with agreed terms, subject to applicable contractual/legal requirements.</td>
      </tr>
      <tr>
        <td><b>6. Packing &amp; Transit Responsibility:</b> Goods shall be suitably packed and identified for safe handling and transit. Loss or damage attributable to inadequate packing or handling shall be to supplier account.</td>
        <td><b>14. Force Majeure:</b> A party prevented from performance by events beyond reasonable control shall promptly notify the other party and take reasonable steps to mitigate delay. Continuing events may be handled as mutually agreed in writing.</td>
      </tr>
      <tr>
        <td><b>7. Rejection &amp; Replacement:</b> Non-conforming, damaged or short-supplied material may be rejected. Supplier shall remove and replace/rectify such material at its cost within the period communicated by Buyer.</td>
        <td><b>15. Confidentiality:</b> Technical, commercial and business information exchanged for the PO shall be kept confidential and used only for performance of the order, unless disclosure is required by law.</td>
      </tr>
      <tr>
        <td><b>8. Risk Purchase / Alternate Procurement:</b> If supplier fails to deliver or replace within the agreed period, Buyer may procure the balance from another source and recover reasonable additional cost from the defaulting supplier, subject to PO terms.</td>
        <td><b>16. Dispute Resolution / Jurisdiction:</b> Governing law, arbitration mechanism and courts having jurisdiction shall be as approved by Jeevaka management/legal before issue of the final standard PO.</td>
      </tr>
    </tbody>
  </table>

  <div class="ack-title">SUPPLIER ACKNOWLEDGEMENT</div>
  <table class="ack-table">
    <tbody>
      <tr>
        <td class="ack-label">Supplier Name</td>
        <td class="ack-val" style="min-height:24px;">&nbsp;</td>
        <td class="ack-label">Authorised Signatory</td>
        <td class="ack-val" style="min-height:24px;">&nbsp;</td>
      </tr>
      <tr>
        <td class="ack-label">Name / Designation</td>
        <td class="ack-val" style="height:28px;">&nbsp;</td>
        <td class="ack-label">Date / Seal</td>
        <td class="ack-val" style="height:28px;">&nbsp;</td>
      </tr>
    </tbody>
  </table>
  <div class="mandatory-note">* Mandatory field in the final company format. Legal wording / approval hierarchy to be confirmed before company-wide release.</div>
</div>
`;
