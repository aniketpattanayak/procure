import { Injectable, OnModuleInit } from '@nestjs/common';
import { MasterCreate } from '@procure/schema';
import type { Tx } from '../../../core/db.service';
import { MastersService } from '../../forms';
import type { InstallContext } from './install-steps';
import { ProcurementInstaller } from './installer.service';
import { SystemTypeInstaller, SystemTypeSpec } from './system-type';

/** Procurement module features (plan feature keys). */
export const FEATURE = { indent: 'indent', quotes: 'vendor_quotes', purchase: 'purchase' } as const;
export const INDENT = 'indent';
export const SELECTION = 'vendor_selection';
export const DEPARTMENT_MASTER = 'department';

const PRIORITY = [{ value: 'Normal', label: 'Normal' }, { value: 'Urgent', label: 'Urgent', color: 'red' }];

/** Indent: requisition raised by a department; verified line by line; source of quotes and selections. */
export const INDENT_SPEC: SystemTypeSpec = {
  moduleKey: FEATURE.indent,
  tabSetting: 'flow.indent.enabled',
  create: {
    key: INDENT, name: 'Indent', pluralName: 'Indents', description: 'Material requisitions (purchase indents)', hasLines: true, itemLines: true,
    numberPattern: 'IND/{FYS}/{SEQ:5}',
    settings: {
      numberLabel: 'Indent No.', icon: 'clipboard-list',
      documentColumns: ['number', 'doc_date', 'location', 'department', 'status', 'required_by'],
      itemColumns: ['number', 'line_no', 'item', 'qty', 'status', 'pending_approval', 'required_date'],
    },
    headerDefinition: {
      fields: [
        { key: 'department', type: 'lookup', label: 'Department', width: 4, source: { kind: 'master', masterKey: DEPARTMENT_MASTER }, display: ['code', 'name'] },
        { key: 'priority', type: 'select', label: 'Priority', width: 4, default: 'Normal', options: PRIORITY },
        { key: 'purpose', type: 'textarea', label: 'Purpose', rows: 3, maxLength: 2000 },
        { key: 'total_amount', type: 'formula', label: 'Estimated value', system: true, hidden: true, expr: 'SUM(lines.amount)', resultType: 'number', precision: 2 },
      ],
    },
    lineDefinition: {
      fields: [
        { key: 'rate', type: 'currency', label: 'Estimated rate', system: true, hidden: true, min: 0 },
        { key: 'amount', type: 'formula', label: 'Estimated amount', system: true, hidden: true, expr: 'qty * rate', resultType: 'number', precision: 2 },
        { key: 'remarks', type: 'text', label: 'Remarks', maxLength: 500, width: 4 },
        { key: 'attachments', type: 'files', label: 'Attachments', maxFiles: 10 },
      ],
    },
  } as SystemTypeSpec['create'],
  extraKeys: [
    { name: 'log_quote', label: 'Log vendor quotes', requiresFeature: FEATURE.quotes },
    { name: 'compare', label: 'Compare quotes', requiresFeature: FEATURE.quotes },
    { name: 'short_close', label: 'Short-close remaining quantity', requiresFeature: FEATURE.indent },
  ],
  workflow: {
    granularity: 'line',
    stages: [{ key: 'verify', name: 'Verification', actions: ['approve', 'reject', 'hold', 'send_back'] }],
  },
  workflowNote: 'Default indent workflow',
};

/** Vendor selection: lines = (indent line, vendor, qty, rate) splits; submit consumes approved indent qty. */
export const SELECTION_SPEC: SystemTypeSpec = {
  moduleKey: FEATURE.quotes,
  tabSetting: 'flow.vendor_selection.enabled',
  create: {
    key: SELECTION, name: 'Vendor Selection', pluralName: 'Vendor Selections', description: 'Vendors chosen for approved indent lines', hasLines: true, itemLines: true,
    numberPattern: 'VS/{FYS}/{SEQ:5}',
    settings: {
      numberLabel: 'Selection No.', icon: 'scale', allowLineCancel: true,
      documentColumns: ['number', 'doc_date', 'location', 'status', 'total_amount'],
      itemColumns: ['number', 'line_no', 'item', 'vendor', 'qty', 'rate', 'status', 'pending_approval'],
    },
    lineDefinition: {
      fields: [
        { key: 'indent_line', type: 'text', label: 'Indent line', hidden: true, readOnly: true, maxLength: 36 },
        { key: 'vendor', type: 'lookup', label: 'Vendor', required: true, width: 4, source: { kind: 'master', masterKey: 'vendor' }, display: ['code', 'name'] },
        { key: 'quote', type: 'text', label: 'Quote', hidden: true, readOnly: true, maxLength: 36 },
        { key: 'over_qty', type: 'decimal', label: 'Over-approved qty', readOnly: true, precision: 3, min: 0, width: 2 },
        { key: 'reason', type: 'text', label: 'Reason', maxLength: 500, width: 4 },
      ],
    },
  } as SystemTypeSpec['create'],
  extraKeys: [
    { name: 'over_approve', label: 'Select more than the approved quantity', requiresFeature: FEATURE.quotes },
  ],
  workflow: {
    granularity: 'line',
    stages: [{ key: 'approve', name: 'Selection approval', actions: ['approve', 'reject', 'hold', 'send_back'] }],
  },
  workflowNote: 'Default vendor selection workflow',
};

/** Agent A's install steps: department master (100), indent (200), vendor_selection (300). */
@Injectable()
export class ProcurementSteps implements OnModuleInit {
  constructor(private readonly installer: ProcurementInstaller, private readonly types: SystemTypeInstaller, private readonly masters: MastersService) {}

  onModuleInit() {
    this.installer.register({ key: 'department_master', order: 100, run: (tx, ctx) => this.department(tx, ctx) });
    this.installer.register({ key: 'indent_type', order: 200, run: async (tx, ctx) => { await this.types.ensure(tx, ctx.tenantId, ctx.actorId, INDENT_SPEC); } });
    this.installer.register({ key: 'vendor_selection_type', order: 300, run: async (tx, ctx) => { await this.types.ensure(tx, ctx.tenantId, ctx.actorId, SELECTION_SPEC); } });
  }

  async department(tx: Tx, ctx: InstallContext) {
    if (await this.masters.find(tx, ctx.tenantId, DEPARTMENT_MASTER)) return;
    await this.masters.create(tx, { tenantId: ctx.tenantId, userId: ctx.actorId, perms: null }, MasterCreate.parse({
      key: DEPARTMENT_MASTER, name: 'Department', pluralName: 'Departments', description: 'Departments that raise indents', settings: { defaultSort: 'code' },
    }), { isSystem: true });
  }
}
