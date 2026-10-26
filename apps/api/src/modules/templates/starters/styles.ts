/**
 * Shared print stylesheet for the starter PDF layouts (A4, clean typography, Indian formats). Kept inside each
 * template body so tenants can copy and edit a template without hidden dependencies.
 */
export const PRINT_CSS = `
<style>
  @page { size: A4; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: 'Inter', 'DejaVu Sans', 'Helvetica Neue', Arial, sans-serif; font-size: 9pt; line-height: 1.38; color: #1f2933;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .doc { position: relative; }
  .muted { color: #6b7785; }
  .small { font-size: 7.6pt; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .center { text-align: center; }
  .nowrap { white-space: nowrap; }
  .strong { font-weight: 600; }
  h1, h2, h3 { margin: 0; }

  /* letterhead */
  .lh { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding-bottom: 10px; border-bottom: 2px solid #12355b; }
  .lh-left { display: flex; gap: 12px; align-items: flex-start; min-width: 0; }
  .lh-logo { max-height: 54px; max-width: 150px; object-fit: contain; }
  .lh-name { font-size: 14pt; font-weight: 700; color: #12355b; letter-spacing: .2px; }
  .lh-meta { font-size: 8pt; color: #4a5560; margin-top: 2px; }
  .lh-right { text-align: right; flex-shrink: 0; }
  .doc-title { font-size: 15pt; font-weight: 700; letter-spacing: 1.5px; color: #12355b; text-transform: uppercase; }
  .doc-badge { display: inline-block; margin-top: 4px; padding: 1px 8px; border-radius: 10px; font-size: 7.5pt; font-weight: 600;
               background: #e8eef5; color: #12355b; text-transform: uppercase; letter-spacing: .5px; }

  /* key facts strip */
  .facts { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid #d5dce3; border-radius: 4px; margin: 10px 0; }
  .facts > div { padding: 5px 8px; border-left: 1px solid #d5dce3; }
  .facts > div:first-child { border-left: 0; }
  .label { font-size: 7pt; text-transform: uppercase; letter-spacing: .6px; color: #6b7785; font-weight: 600; }
  .value { font-weight: 600; font-size: 9pt; }

  /* party blocks */
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
  .box { border: 1px solid #d5dce3; border-radius: 4px; padding: 7px 9px; }
  .box h3 { font-size: 7.2pt; text-transform: uppercase; letter-spacing: .7px; color: #12355b; margin-bottom: 4px; }
  .box .name { font-weight: 700; font-size: 10pt; }
  .kv { display: grid; grid-template-columns: auto 1fr; column-gap: 8px; row-gap: 1px; margin-top: 3px; }
  .kv .k { color: #6b7785; }

  /* line items */
  table.items { width: 100%; border-collapse: collapse; margin-top: 2px; }
  table.items thead { display: table-header-group; }
  table.items tr { page-break-inside: avoid; }
  table.items th { background: #12355b; color: #fff; font-weight: 600; font-size: 7.4pt; text-transform: uppercase; letter-spacing: .3px;
                   padding: 5px 5px; text-align: left; border: 1px solid #12355b; }
  table.items th.num { text-align: right; }
  table.items th.center { text-align: center; }
  table.items td { padding: 5px 5px; border: 1px solid #d5dce3; vertical-align: top; }
  table.items tbody tr:nth-child(even) td { background: #f7f9fb; }
  table.items .sub { color: #6b7785; font-size: 7.6pt; }
  table.items tr.cancelled td { color: #9aa5b1; text-decoration: line-through; }
  table.items tfoot td { font-weight: 700; background: #eef2f6; border: 1px solid #d5dce3; padding: 5px; }

  /* totals */
  .summary { display: grid; grid-template-columns: 1fr 230px; gap: 12px; margin-top: 10px; page-break-inside: avoid; }
  table.totals { width: 100%; border-collapse: collapse; }
  table.totals td { padding: 3px 6px; border-bottom: 1px solid #e3e8ed; }
  table.totals tr.grand td { border-top: 2px solid #12355b; border-bottom: 2px solid #12355b; font-weight: 700; font-size: 10.5pt; color: #12355b; padding: 5px 6px; }
  .words { border: 1px dashed #b8c3ce; border-radius: 4px; padding: 6px 8px; background: #fbfcfd; }

  /* terms + sign-off */
  .section-title { font-size: 7.6pt; text-transform: uppercase; letter-spacing: .7px; color: #12355b; font-weight: 700; margin: 12px 0 4px; }
  ol.terms { margin: 0; padding-left: 16px; }
  ol.terms li { margin-bottom: 3px; }
  ol.terms .tname { font-weight: 600; }
  .tbody { white-space: pre-line; }
  .signoff { display: grid; grid-template-columns: 110px 1fr 220px; gap: 14px; align-items: end; margin-top: 16px; page-break-inside: avoid; }
  .qr { display: block; }
  .qr-cap { font-size: 6.8pt; color: #6b7785; margin-top: 2px; word-break: break-all; }
  .sign { text-align: center; }
  .sign .space { height: 46px; display: flex; align-items: flex-end; justify-content: center; }
  .sign .space img { max-height: 44px; max-width: 180px; }
  .sign .line { border-top: 1px solid #1f2933; padding-top: 3px; font-weight: 600; }
  table.approvals { width: 100%; border-collapse: collapse; font-size: 7.8pt; }
  table.approvals th { text-align: left; color: #6b7785; font-weight: 600; border-bottom: 1px solid #d5dce3; padding: 2px 4px; }
  table.approvals th.num { text-align: right; }
  table.approvals td { border-bottom: 1px solid #eef1f4; padding: 2px 4px; }
  .sig-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-top: 34px; page-break-inside: avoid; }
  .sig-row > div { border-top: 1px solid #1f2933; padding-top: 3px; text-align: center; font-weight: 600; }
  .watermark { position: fixed; top: 38%; left: 0; right: 0; text-align: center; font-size: 90pt; font-weight: 800; color: rgba(200, 30, 30, .08);
               transform: rotate(-24deg); letter-spacing: 8px; z-index: -1; }
  .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid #d5dce3; border-radius: 4px; margin: 10px 0; }
  .fields > div { padding: 5px 8px; border-bottom: 1px solid #eef1f4; }
  .fields > div:nth-child(odd) { border-right: 1px solid #eef1f4; }
  .fields .value { font-weight: 500; white-space: pre-line; }
</style>`;

/** Letterhead block shared by the starter layouts. */
export const LETTERHEAD = `
<div class="lh">
  <div class="lh-left">
    {{#if tenant.logoUrl}}<img class="lh-logo" src="{{tenant.logoUrl}}" alt="">{{/if}}
    <div>
      <div class="lh-name">{{tenant.legalName}}</div>
      {{#if tenant.addressText}}<div class="lh-meta">{{tenant.addressText}}</div>{{/if}}
      <div class="lh-meta">
        {{#if tenant.gstin}}<span class="strong">GSTIN</span> {{tenant.gstin}}{{/if}}
        {{#if tenant.pan}}&nbsp;&nbsp;<span class="strong">PAN</span> {{tenant.pan}}{{/if}}
        {{#if tenant.stateCode}}&nbsp;&nbsp;<span class="strong">State code</span> {{tenant.stateCode}}{{/if}}
      </div>
    </div>
  </div>
  <div class="lh-right">
    <div class="doc-title">__TITLE__</div>
    <div class="doc-badge">{{document.statusLabel}}</div>
  </div>
</div>`;

export const letterhead = (title: string) => LETTERHEAD.replace('__TITLE__', title);

export const DRAFT_WATERMARK = `{{#if document.isDraft}}<div class="watermark">DRAFT</div>{{/if}}`;

/** Page footer (Chromium header/footer template: own font sizes, pageNumber/totalPages classes). */
export const pageFooter = (label: string) =>
  `<div style="width:100%;font-family:'Inter','DejaVu Sans',sans-serif;font-size:7pt;color:#6b7785;padding:0 12mm;display:flex;justify-content:space-between;">` +
  `<span>{{tenant.legalName}} · ${label} {{document.number}}</span>` +
  `<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
