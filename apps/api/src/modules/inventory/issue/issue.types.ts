import type { SystemTypeSpec } from '../../procurement';
import { STORE_FEATURE } from '../common';

export const ISSUE_REQUEST = 'issue_request';
export const STORE_ISSUE = 'store_issue';
export const STORE_RETURN = 'store_return';
export const ISSUE_WITHOUT_INDENT = 'flow.issue.without_indent';

export const ISSUE_LINE = { requestLine: 'request_line', batchNo: 'batch_no' } as const;
export const RETURN_LINE = { issueLine: 'issue_line', batchNo: 'batch_no', status: 'return_status' } as const;

const text = (key: string, label: string, width = 3, extra: Record<string, unknown> = {}) => ({ key, type: 'text', label, maxLength: 200, width, ...extra });
const hiddenRef = (key: string, label: string) => ({ key, type: 'text', label, hidden: true, readOnly: true, maxLength: 36 });
const department = { key: 'department', type: 'lookup', label: 'Department', width: 4, source: { kind: 'master', masterKey: 'department' }, display: ['code', 'name'] };

/** Store requisition: a department asks the store for material; approved lines become issuable. */
export const ISSUE_REQUEST_SPEC: SystemTypeSpec = {
  moduleKey: STORE_FEATURE,
  tabSetting: null,
  create: {
    key: ISSUE_REQUEST, name: 'Issue Request', pluralName: 'Issue Requests', description: 'Material requisitions on the store', hasLines: true, itemLines: true,
    numberPattern: 'IR/{FYS}/{SEQ:5}',
    settings: {
      numberLabel: 'Request No.', icon: 'hand', allowLineCancel: true,
      documentColumns: ['number', 'doc_date', 'location', 'department', 'status'],
      itemColumns: ['number', 'line_no', 'item', 'qty', 'status', 'pending_approval', 'required_date'],
    },
    headerDefinition: {
      fields: [
        department,
        { key: 'purpose', type: 'textarea', label: 'Purpose', rows: 2, maxLength: 1000 },
      ],
    },
    lineDefinition: {
      fields: [
        { key: 'required_date', type: 'date', label: 'Required date', system: true, width: 2 },
        text('purpose', 'Purpose', 4, { maxLength: 500 }),
      ],
    },
  } as SystemTypeSpec['create'],
  extraKeys: [],
  workflow: { granularity: 'line', stages: [{ key: 'approve', name: 'Request approval', actions: ['approve', 'partial', 'reject', 'hold', 'send_back'] }] },
  workflowNote: 'Default issue request workflow',
};

/** Store issue: material out of the store against approved request lines (or direct when the setting allows). */
export const STORE_ISSUE_SPEC: SystemTypeSpec = {
  moduleKey: STORE_FEATURE,
  tabSetting: null,
  create: {
    key: STORE_ISSUE, name: 'Store Issue', pluralName: 'Store Issues', description: 'Material issued from the store', hasLines: true, itemLines: true,
    numberPattern: 'ISS/{FYS}/{SEQ:5}',
    settings: {
      numberLabel: 'Issue No.', icon: 'package-minus', allowLineCancel: true,
      documentColumns: ['number', 'doc_date', 'location', 'department', 'status'],
      itemColumns: ['number', 'line_no', 'item', 'qty', 'status', 'pending_approval'],
    },
    headerDefinition: {
      fields: [
        department,
        text('issued_to', 'Issued to', 4),
        hiddenRef('request', 'Issue request'),
      ],
    },
    lineDefinition: {
      fields: [
        { key: 'location', type: 'lookup', label: 'Issue from', system: true, width: 3, source: { kind: 'location', activeOnly: true, withinScope: true }, display: ['code', 'name'] },
        text(ISSUE_LINE.batchNo, 'Batch no.', 2, { maxLength: 60 }),
        text('purpose', 'Purpose', 4, { maxLength: 500 }),
        hiddenRef(ISSUE_LINE.requestLine, 'Request line'),
      ],
    },
  } as SystemTypeSpec['create'],
  extraKeys: [],
  workflow: {
    granularity: 'line',
    stages: [{ key: 'approve', name: 'Issue approval', actions: ['approve', 'partial', 'reject', 'hold', 'send_back'], effects: { onApprove: [{ effect: 'post_stock', stockStatus: 'available' }] } }],
  },
  workflowNote: 'Default store issue workflow',
};

/** Store return: issued material coming back (to available or quarantine). */
export const STORE_RETURN_SPEC: SystemTypeSpec = {
  moduleKey: STORE_FEATURE,
  tabSetting: null,
  create: {
    key: STORE_RETURN, name: 'Store Return', pluralName: 'Store Returns', description: 'Issued material returned to the store', hasLines: true, itemLines: true,
    numberPattern: 'SRT/{FYS}/{SEQ:5}',
    settings: {
      numberLabel: 'Return No.', icon: 'package-plus', allowLineCancel: true,
      documentColumns: ['number', 'doc_date', 'location', 'department', 'status'],
      itemColumns: ['number', 'line_no', 'item', 'qty', 'status', 'pending_approval'],
    },
    headerDefinition: {
      fields: [
        department,
        text('returned_by', 'Returned by', 4),
      ],
    },
    lineDefinition: {
      fields: [
        { key: 'location', type: 'lookup', label: 'Return to', system: true, width: 3, source: { kind: 'location', activeOnly: true, withinScope: true }, display: ['code', 'name'] },
        text(RETURN_LINE.batchNo, 'Batch no.', 2, { maxLength: 60 }),
        {
          key: RETURN_LINE.status, type: 'select', label: 'Return as', width: 2, default: 'available',
          options: [{ value: 'available', label: 'Available' }, { value: 'quarantine', label: 'Quarantine' }],
        },
        text('reason', 'Reason', 4, { maxLength: 500 }),
        hiddenRef(RETURN_LINE.issueLine, 'Issue line'),
      ],
    },
  } as SystemTypeSpec['create'],
  extraKeys: [],
  workflow: {
    granularity: 'line',
    stages: [{ key: 'approve', name: 'Return approval', actions: ['approve', 'partial', 'reject', 'hold', 'send_back'], effects: { onApprove: [{ effect: 'post_stock', stockStatus: 'available' }] } }],
  },
  workflowNote: 'Default store return workflow',
};
