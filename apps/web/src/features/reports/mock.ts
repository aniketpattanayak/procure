/**
 * Typed in-memory mock of the Phase 7 API, used while `modules/reports` is being built (and for UI work offline).
 * Turn on with NEXT_PUBLIC_REPORTS_MOCK=1 or localStorage `procure.reportsMock` = '1'. The run engine is a small
 * reference implementation of the contract: filters, group by + aggregates, totals, group subtotals, chart series.
 */
import { ApiError, type RequestOptions } from '@/lib/api';
import type {
  CatalogueField, DashboardRow, ExportJob, ReportDefinition, ReportResult, ReportRow, ScheduleRow, SourceCatalogue, WidgetData,
} from './types';

const f = (id: string, label: string, type: CatalogueField['type'], path: string[], o: Partial<CatalogueField> = {}): CatalogueField => ({
  id, label, type, path, groupable: type !== 'number' && type !== 'currency', filterable: true, aggregatable: type === 'number' || type === 'currency', ...o,
});

const docFields = (): CatalogueField[] => [
  f('number', 'Number', 'text', ['Document']),
  f('status', 'Status', 'status', ['Document']),
  f('doc_date', 'Document date', 'date', ['Document']),
  f('doc_date.month', 'Document month', 'text', ['Document', 'Date parts']),
  f('doc_date.quarter', 'Document quarter', 'text', ['Document', 'Date parts']),
  f('submitted_at', 'Submitted at', 'datetime', ['Document']),
  f('amount', 'Amount', 'currency', ['Document']),
  f('overdue', 'Overdue', 'boolean', ['Workflow'], { groupable: true }),
  f('wf.stage', 'Current stage', 'text', ['Workflow']),
  f('location.name', 'Location', 'lookup', ['Location']),
  f('location.path', 'Location path', 'text', ['Location']),
  f('created_by.name', 'Created by', 'lookup', ['Creator']),
  f('custom.priority', 'Priority', 'text', ['Custom fields']),
  f('custom.justification', 'Justification', 'text', ['Custom fields'], { groupable: false }),
  f('id', 'Document id', 'text', ['Document'], { groupable: false, filterable: false }),
];

const SOURCES: SourceCatalogue[] = [
  { source: { kind: 'doc', key: 'capex' }, label: 'Capex requests', fields: docFields() },
  { source: { kind: 'doc', key: 'indent' }, label: 'Indents', fields: docFields() },
  {
    source: { kind: 'doc_line', key: 'capex' }, label: 'Capex request lines', fields: [
      ...docFields().map(x => ({ ...x, path: ['Header', ...x.path.slice(1)], id: x.id })),
      f('line.no', 'Line no', 'number', ['Line'], { aggregatable: false }),
      f('line.qty', 'Quantity', 'number', ['Line']),
      f('line.rate', 'Rate', 'currency', ['Line']),
      f('line.amount', 'Line amount', 'currency', ['Line']),
      f('qty.pending_approval', 'Pending approval', 'number', ['Line', 'Quantities']),
      f('qty.approved', 'Approved qty', 'number', ['Line', 'Quantities']),
      f('item.code', 'Item code', 'text', ['Item']),
      f('item.name', 'Item name', 'text', ['Item']),
      f('item.category.name', 'Category', 'lookup', ['Item', 'Category']),
    ],
  },
  { source: { kind: 'master', key: 'item' }, label: 'Items', fields: [f('code', 'Code', 'text', ['Item']), f('name', 'Name', 'text', ['Item']), f('active', 'Active', 'boolean', ['Item'], { groupable: true }), f('category.name', 'Category', 'lookup', ['Item', 'Category'])] },
  { source: { kind: 'master', key: 'vendor' }, label: 'Vendors', fields: [f('code', 'Code', 'text', ['Vendor']), f('name', 'Name', 'text', ['Vendor']), f('active', 'Active', 'boolean', ['Vendor'], { groupable: true })] },
  { source: { kind: 'engine', key: 'workflow_pending' }, label: 'Pending approvals', fields: [f('user.name', 'Approver', 'lookup', ['Approver']), f('stage', 'Stage', 'text', ['Workflow']), f('doc_type', 'Document type', 'text', ['Workflow']), f('pending', 'Pending', 'number', ['Workflow']), f('overdue', 'Overdue', 'number', ['Workflow'])] },
  { source: { kind: 'engine', key: 'audit' }, label: 'Audit trail', fields: [f('at', 'When', 'datetime', ['Event']), f('action', 'Action', 'text', ['Event']), f('entity', 'Entity', 'text', ['Event']), f('user.name', 'User', 'lookup', ['User'])] },
];

// ----------------------------------------------------------------------------- data

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const LOCS = ['Head Office', 'Mumbai Plant', 'Pune Warehouse', 'Chennai Depot', 'Delhi Branch'];
const STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'closed'];
const STAGES = ['Manager', 'Finance', 'Director'];
const USERS = ['Asha Rao', 'Vikram Shah', 'Neha Iyer', 'Rohan Das'];
const CATS = ['Machinery', 'IT hardware', 'Furniture', 'Vehicles', 'Tools'];

function monthLabel(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }

const DOCS: Record<string, unknown>[] = (() => {
  const out: Record<string, unknown>[] = [];
  const now = new Date();
  for (let i = 0; i < 180; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - Math.floor(rnd() * 6), 1 + Math.floor(rnd() * 27));
    const status = STATUSES[Math.floor(rnd() * STATUSES.length)]!;
    const id = `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`;
    const loc = LOCS[Math.floor(rnd() * (rnd() < 0.5 ? 2 : LOCS.length))]!;
    const qty = 1 + Math.floor(rnd() * 8);
    const rate = Math.round(5000 + rnd() * 120000);
    out.push({
      id, number: `CPX/${monthLabel(d).replace('-', '')}/${String(i + 1).padStart(4, '0')}`, status, doc_date: d.toISOString().slice(0, 10),
      'doc_date.month': monthLabel(d), 'doc_date.quarter': `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`,
      submitted_at: status === 'draft' ? null : d.toISOString(), amount: qty * rate, overdue: status === 'submitted' && rnd() < 0.3,
      'wf.stage': status === 'submitted' ? STAGES[Math.floor(rnd() * 3)] : null, 'location.name': loc, 'location.path': `Acme › ${loc}`,
      'created_by.name': USERS[Math.floor(rnd() * USERS.length)], 'custom.priority': ['Low', 'Normal', 'High'][Math.floor(rnd() * 3)],
      'custom.justification': 'Replacement of ageing equipment', 'line.no': 1, 'line.qty': qty, 'line.rate': rate, 'line.amount': qty * rate,
      'qty.pending_approval': status === 'submitted' ? qty : 0, 'qty.approved': status === 'approved' ? qty : 0,
      'item.code': `IT-${100 + (i % 40)}`, 'item.name': `Item ${100 + (i % 40)}`, 'item.category.name': CATS[i % CATS.length],
      __link: `/docs/capex/${id}`,
    });
  }
  return out;
})();

function datasetFor(src: ReportDefinition['source']): Record<string, unknown>[] {
  if (src.kind === 'doc' || src.kind === 'doc_line') return DOCS;
  if (src.kind === 'master') return Array.from({ length: 40 }, (_, i) => ({ code: `IT-${100 + i}`, name: `Item ${100 + i}`, active: i % 7 !== 0, 'category.name': CATS[i % CATS.length] }));
  if (src.key === 'workflow_pending') {
    return USERS.flatMap(u => STAGES.map(s => ({ 'user.name': u, stage: s, doc_type: 'Capex request', pending: Math.floor(rnd() * 9), overdue: Math.floor(rnd() * 3) })));
  }
  return Array.from({ length: 60 }, (_, i) => ({ at: new Date(Date.now() - i * 3600_000).toISOString(), action: ['create', 'update', 'approve'][i % 3], entity: 'document', 'user.name': USERS[i % USERS.length] }));
}

// ----------------------------------------------------------------------------- engine

function matches(row: Record<string, unknown>, flt: ReportDefinition['filters'][number], params: Record<string, unknown>): boolean {
  const value = flt.param && params[flt.param.key] !== undefined ? params[flt.param.key] : flt.value;
  if (value === undefined || value === null || value === '') return flt.op === 'is_empty' || flt.op === 'not_empty' ? test() : true;
  return test();
  function test() {
    const v = row[flt.field];
    const s = v == null ? '' : String(v);
    switch (flt.op) {
      case 'eq': return s === String(value);
      case 'ne': return s !== String(value);
      case 'in': return (Array.isArray(value) ? value : String(value).split(',')).map(String).includes(s);
      case 'not_in': return !(Array.isArray(value) ? value : String(value).split(',')).map(String).includes(s);
      case 'contains': return s.toLowerCase().includes(String(value).toLowerCase());
      case 'starts_with': return s.toLowerCase().startsWith(String(value).toLowerCase());
      case 'gt': return Number(v) > Number(value);
      case 'gte': return Number(v) >= Number(value);
      case 'lt': return Number(v) < Number(value);
      case 'lte': return Number(v) <= Number(value);
      case 'between': {
        const [a, b] = Array.isArray(value) ? value : [];
        const x = s.slice(0, 10);
        return (!a || x >= String(a)) && (!b || x <= String(b));
      }
      case 'is_empty': return s === '';
      case 'not_empty': return s !== '';
      case 'within_location': return true; // the mock has no location tree; the server applies the subtree
      default: return true;
    }
  }
}

function agg(values: unknown[], a: string): unknown {
  const nums = values.map(Number).filter(n => Number.isFinite(n));
  switch (a) {
    case 'sum': return nums.reduce((s, n) => s + n, 0);
    case 'avg': return nums.length ? Math.round((nums.reduce((s, n) => s + n, 0) / nums.length) * 100) / 100 : null;
    case 'min': return nums.length ? Math.min(...nums) : null;
    case 'max': return nums.length ? Math.max(...nums) : null;
    case 'count': return values.length;
    case 'count_distinct': return new Set(values.map(String)).size;
    default: return values[0] ?? null;
  }
}

export function mockRun(def: ReportDefinition, params: Record<string, unknown>, limit = 200): ReportResult {
  const cat = SOURCES.find(s => s.source.kind === def.source.kind && s.source.key === def.source.key);
  const fieldType = (id: string) => cat?.fields.find(x => x.id === id)?.type ?? 'text';
  let data = datasetFor(def.source).filter(r => (def.filters ?? []).every(fl => matches(r, fl, params)));
  for (const s of [...(def.sort ?? [])].reverse()) {
    data = [...data].sort((a, b) => {
      const x = a[s.field] as string | number; const y = b[s.field] as string | number;
      return (x > y ? 1 : x < y ? -1 : 0) * (s.dir === 'desc' ? -1 : 1);
    });
  }
  const columns = def.columns.map(c => ({ field: c.field, label: c.label || cat?.fields.find(x => x.id === c.field)?.label || c.field, type: fieldType(c.field), aggregate: c.aggregate ?? 'none' }));
  const grouped = (def.groupBy ?? []).length > 0 || def.columns.some(c => c.aggregate && c.aggregate !== 'none');
  let rows: unknown[][];
  let links: (string | null)[] | undefined;
  let groups: ReportResult['groups'];
  const aggregateRows = (set: Record<string, unknown>[]) => def.columns.map(c => (c.aggregate && c.aggregate !== 'none' ? agg(set.map(r => r[c.field]), c.aggregate) : null));
  if (grouped) {
    const keyFields = def.groupBy ?? [];
    const buckets = new Map<string, Record<string, unknown>[]>();
    for (const r of data) {
      const k = JSON.stringify(keyFields.map(g => r[g] ?? null));
      buckets.set(k, [...(buckets.get(k) ?? []), r]);
    }
    const keys = [...buckets.keys()].sort();
    rows = keys.map(k => {
      const set = buckets.get(k)!;
      return def.columns.map(c => (c.aggregate && c.aggregate !== 'none' ? agg(set.map(r => r[c.field]), c.aggregate) : set[0]![c.field] ?? null));
    });
    if (keyFields.length > 1) {
      const top = new Map<string, Record<string, unknown>[]>();
      for (const r of data) { const k = JSON.stringify([r[keyFields[0]!] ?? null]); top.set(k, [...(top.get(k) ?? []), r]); }
      groups = [...top.entries()].map(([k, set]) => ({ key: JSON.parse(k) as unknown[], rowCount: set.length, totals: aggregateRows(set) }));
    }
  } else {
    rows = data.slice(0, Math.min(limit, def.rowLimit ?? 10_000)).map(r => def.columns.map(c => r[c.field] ?? null));
    links = data.slice(0, rows.length).map(r => (r.__link as string) ?? null);
  }
  const totals = def.totals ? aggregateRows(data).map((v, i) => (def.columns[i]!.aggregate === 'none' && (fieldType(def.columns[i]!.field) === 'currency' || fieldType(def.columns[i]!.field) === 'number') && !grouped ? agg(data.map(r => r[def.columns[i]!.field]), 'sum') : v)) : null;
  return { columns, rows, totals, groups, nextCursor: null, truncated: data.length > rows.length && !grouped, links };
}

// ----------------------------------------------------------------------------- store

const now = () => new Date().toISOString();
const uid = () => (globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(16).slice(2)}`);

const REPORTS: ReportRow[] = [
  {
    id: '11111111-0000-7000-8000-000000000001', key: 'pending_approvals_by_user', name: 'Pending approvals by user and stage', kind: 'builtin',
    description: 'Who has approvals waiting, at which stage, and how many are overdue.',
    definition: { source: { kind: 'engine', key: 'workflow_pending' }, columns: [{ field: 'user.name', aggregate: 'none', format: 'auto' }, { field: 'stage', aggregate: 'none', format: 'auto' }, { field: 'pending', aggregate: 'sum', format: 'auto' }, { field: 'overdue', aggregate: 'sum', format: 'auto' }], filters: [], groupBy: ['user.name', 'stage'], sort: [], totals: true, datePreset: 'none', rowLimit: 10_000, chart: { type: 'stacked_bar', x: 'user.name', series: ['pending'] } },
  },
  {
    id: '11111111-0000-7000-8000-000000000002', key: 'documents_by_status_location', name: 'Documents by status and location', kind: 'builtin',
    description: 'Document counts and value per location, split by status.',
    definition: { source: { kind: 'doc', key: 'capex' }, columns: [{ field: 'location.name', aggregate: 'none', format: 'auto' }, { field: 'status', aggregate: 'none', format: 'auto' }, { field: 'id', label: 'Documents', aggregate: 'count', format: 'auto' }, { field: 'amount', aggregate: 'sum', format: 'auto' }], filters: [{ field: 'doc_date', op: 'between', param: { key: 'period', label: 'Period', required: false } }, { field: 'location.name', op: 'within_location', param: { key: 'location', label: 'Location', required: false } }], groupBy: ['location.name', 'status'], sort: [], totals: true, datePreset: 'this_fy', rowLimit: 10_000, chart: { type: 'bar', x: 'location.name', series: ['id'] } },
  },
  {
    id: '11111111-0000-7000-8000-000000000003', key: 'audit_trail', name: 'Audit trail', kind: 'builtin', description: 'Every change, who made it and when.',
    definition: { source: { kind: 'engine', key: 'audit' }, columns: [{ field: 'at', aggregate: 'none', format: 'auto' }, { field: 'user.name', aggregate: 'none', format: 'auto' }, { field: 'action', aggregate: 'none', format: 'auto' }, { field: 'entity', aggregate: 'none', format: 'auto' }], filters: [{ field: 'at', op: 'between', param: { key: 'period', label: 'Period', required: false } }], groupBy: [], sort: [{ field: 'at', dir: 'desc' }], totals: false, datePreset: 'last_30_days', rowLimit: 10_000 },
  },
  {
    id: '11111111-0000-7000-8000-000000000004', key: 'users_and_roles', name: 'Users and roles', kind: 'builtin', description: 'Users with their roles and status.',
    definition: { source: { kind: 'master', key: 'item' }, columns: [{ field: 'code', aggregate: 'none', format: 'auto' }, { field: 'name', aggregate: 'none', format: 'auto' }, { field: 'active', aggregate: 'none', format: 'auto' }], filters: [], groupBy: [], sort: [], totals: false, datePreset: 'none', rowLimit: 10_000 },
  },
  {
    id: '22222222-0000-7000-8000-000000000001', key: 'capex_detail', name: 'Capex register', kind: 'custom', ownerUserId: 'me', ownerName: 'You', updatedAt: now(),
    description: 'Every capex request with location, status and value.',
    definition: { source: { kind: 'doc', key: 'capex' }, columns: [{ field: 'number', aggregate: 'none', format: 'auto' }, { field: 'doc_date', aggregate: 'none', format: 'auto' }, { field: 'location.name', aggregate: 'none', format: 'auto' }, { field: 'status', aggregate: 'none', format: 'auto' }, { field: 'created_by.name', aggregate: 'none', format: 'auto' }, { field: 'amount', aggregate: 'none', format: 'auto' }], filters: [{ field: 'doc_date', op: 'between', param: { key: 'period', label: 'Period', required: false } }, { field: 'status', op: 'eq', param: { key: 'status', label: 'Status', required: false } }], groupBy: [], sort: [{ field: 'doc_date', dir: 'desc' }], totals: true, datePreset: 'none', rowLimit: 10_000 },
  },
  {
    id: '33333333-0000-7000-8000-000000000001', key: 'capex_by_category', name: 'Capex by item category', kind: 'custom', ownerUserId: 'someone', ownerName: 'Vikram Shah', sharedRoleIds: ['r1'], updatedAt: now(),
    definition: { source: { kind: 'doc_line', key: 'capex' }, columns: [{ field: 'item.category.name', aggregate: 'none', format: 'auto' }, { field: 'line.amount', aggregate: 'sum', format: 'auto' }], filters: [], groupBy: ['item.category.name'], sort: [], totals: true, datePreset: 'none', rowLimit: 10_000, chart: { type: 'pie', x: 'item.category.name', series: ['line.amount'] } },
  },
];
const SCHEDULES: ScheduleRow[] = [];
const EXPORTS: (ExportJob & { readyAt: number })[] = [
  { id: uid(), kind: 'report', format: 'xlsx', status: 'ready', rowCount: 412, fileUrl: '/api/v1/files/mock/download', error: null, createdAt: new Date(Date.now() - 86400_000 * 2).toISOString(), finishedAt: new Date(Date.now() - 86400_000 * 2 + 9000).toISOString(), name: 'Capex register', readyAt: 0 },
  { id: uid(), kind: 'list', format: 'csv', status: 'failed', rowCount: null, fileUrl: null, error: 'Statement timeout after 15 s. Narrow the filters and try again.', createdAt: new Date(Date.now() - 86400_000 * 3).toISOString(), finishedAt: new Date(Date.now() - 86400_000 * 3 + 15000).toISOString(), name: 'Capex requests list', readyAt: 0 },
  { id: uid(), kind: 'report', format: 'pdf', status: 'expired', rowCount: 88, fileUrl: null, error: null, createdAt: new Date(Date.now() - 86400_000 * 9).toISOString(), finishedAt: new Date(Date.now() - 86400_000 * 9).toISOString(), name: 'Audit trail', readyAt: 0 },
];

const BUILTIN_DASH: DashboardRow = {
  id: '44444444-0000-7000-8000-000000000000', builtin: 'my_work', name: 'My work', widgets: [
    { id: 'inbox', type: 'inbox_counts', title: 'Waiting for my approval', params: {}, x: 0, y: 0, w: 4, h: 4 },
    { id: 'docs-capex', type: 'doc_counts', title: 'Capex requests', docTypeKey: 'capex', params: {}, x: 4, y: 0, w: 4, h: 4 },
    { id: 'docs-indent', type: 'doc_counts', title: 'Indents', docTypeKey: 'indent', params: {}, x: 8, y: 0, w: 4, h: 4 },
  ],
};
const DASHBOARDS: DashboardRow[] = [
  {
    id: '44444444-0000-7000-8000-000000000001', name: 'Approver overview', isMine: true, canEdit: true, isDefaultForRoleIds: [], sharedRoleIds: [], ownerUserId: 'me', version: 1,
    widgets: [
      { id: 'k1', type: 'kpi', title: 'Capex this month', reportId: REPORTS[4]!.id, params: { field: 'amount' }, x: 0, y: 0, w: 3, h: 2 },
      { id: 'k2', type: 'kpi', title: 'Documents', reportId: REPORTS[1]!.id, params: { field: 'id' }, x: 3, y: 0, w: 3, h: 2 },
      { id: 'inbox', type: 'inbox_counts', title: 'Waiting for my approval', params: {}, x: 6, y: 0, w: 6, h: 4 },
      { id: 'c1', type: 'chart', title: 'Capex by location', reportId: REPORTS[1]!.id, params: {}, x: 0, y: 2, w: 6, h: 4 },
      { id: 'd1', type: 'doc_counts', title: 'Capex requests', docTypeKey: 'capex', params: {}, x: 6, y: 4, w: 6, h: 3 },
      { id: 't1', type: 'table', title: 'Pending by approver', reportId: REPORTS[0]!.id, params: {}, x: 0, y: 6, w: 6, h: 4 },
    ],
  },
];

function widgetData(widgetId: string, dashboardId: string): WidgetData {
  const dash = [...DASHBOARDS, BUILTIN_DASH].find(d => d.id === dashboardId) ?? BUILTIN_DASH;
  const w = dash.widgets.find(x => x.id === widgetId);
  if (!w) throw new ApiError({ status: 404, code: 'NOT_FOUND', title: 'Widget not found' });
  if (w.type === 'doc_counts') {
    const counts = STATUSES.map(s => ({ statusKey: s, label: s[0]!.toUpperCase() + s.slice(1), count: DOCS.filter(d => d.status === s).length, link: `/docs/${w.docTypeKey}?status=${s}` }));
    return { type: 'doc_counts', types: [{ docTypeKey: w.docTypeKey ?? 'capex', name: w.title, link: `/docs/${w.docTypeKey}`, total: counts.reduce((a, c) => a + c.count, 0), counts }] };
  }
  const rep = REPORTS.find(r => r.id === w.reportId);
  if (!rep) throw new ApiError({ status: 404, code: 'NOT_FOUND', title: 'Report not found' });
  const res = mockRun(rep.definition, w.params ?? {});
  if (w.type === 'kpi') {
    const field = String(w.params?.field ?? '');
    const idx = Math.max(0, rep.definition.columns.findIndex(c => c.field === field));
    const value = Number(res.totals?.[idx] ?? 0);
    return { type: 'kpi', value, delta: value - value / 1.124, deltaPct: 12.4, previous: value / 1.124, label: res.columns[idx]?.label, valueType: res.columns[idx]?.type };
  }
  return { ...res, type: w.type as 'chart' | 'table' };
}

// ----------------------------------------------------------------------------- router

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function mockCall<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  await delay(120 + Math.random() * 200);
  const method = opts.method ?? 'GET';
  const body = (opts.body ?? {}) as Record<string, unknown>;
  const seg = path.split('?')[0]!.split('/').filter(Boolean).map(decodeURIComponent);
  const r = <X>(v: X) => v as unknown as T;
  const notFound = () => { throw new ApiError({ status: 404, code: 'NOT_FOUND', title: 'Not found' }); };

  if (seg[0] === 'reports') {
    if (seg[1] === 'sources') return r(SOURCES);
    if (seg[1] === 'preview') return r(mockRun(body.definition as ReportDefinition, (body.params ?? {}) as Record<string, unknown>));
    if (seg.length === 1 && method === 'GET') return r(REPORTS);
    if (seg.length === 1 && method === 'POST') {
      if (REPORTS.some(x => x.key === body.key)) throw new ApiError({ status: 409, code: 'CONFLICT', title: 'A report with this key exists.', errors: [{ path: 'key', message: 'Already used' }] });
      const row: ReportRow = { ...(body as unknown as ReportRow), id: uid(), kind: 'custom', ownerUserId: 'me', ownerName: 'You', updatedAt: now(), version: 1 };
      REPORTS.push(row);
      return r(row);
    }
    const rep = REPORTS.find(x => x.id === seg[1]) ?? notFound();
    if (seg[2] === 'run') {
      const p = (body.page ?? {}) as { limit?: number };
      return r(mockRun(rep.definition, (body.params ?? {}) as Record<string, unknown>, p.limit));
    }
    if (seg[2] === 'schedules') {
      if (method === 'GET') return r(SCHEDULES.filter(s => s.reportId === rep.id));
      if (method === 'POST') { const s = { ...(body as unknown as ScheduleRow), id: uid(), reportId: rep.id, isActive: true, nextRunAt: new Date(Date.now() + 86400_000).toISOString() }; SCHEDULES.push(s); return r(s); }
      if (method === 'DELETE') { const i = SCHEDULES.findIndex(s => s.id === seg[3]); if (i >= 0) SCHEDULES.splice(i, 1); return r(undefined); }
    }
    if (method === 'GET') return r(rep);
    if (rep.kind === 'builtin') throw new ApiError({ status: 403, code: 'FORBIDDEN', title: 'Built-in reports are read-only. Copy it to customise.' });
    if (method === 'PUT') { Object.assign(rep, body, { updatedAt: now(), version: (rep.version ?? 1) + 1 }); return r(rep); }
    if (method === 'DELETE') { REPORTS.splice(REPORTS.indexOf(rep), 1); return r(undefined); }
  }

  if (seg[0] === 'exports') {
    const tick = () => EXPORTS.forEach(e => {
      if (e.status === 'queued' && Date.now() > e.readyAt - 2000) e.status = 'running';
      if ((e.status === 'running' || e.status === 'queued') && Date.now() > e.readyAt) Object.assign(e, { status: 'ready', rowCount: 180, fileUrl: '/api/v1/files/mock/download', finishedAt: now() });
    });
    tick();
    if (method === 'POST') {
      const src = body.source as { reportId?: string };
      const job = { id: uid(), kind: String(body.kind), format: String(body.format), status: 'queued' as const, rowCount: null, fileUrl: null, error: null, createdAt: now(), finishedAt: null, name: REPORTS.find(x => x.id === src?.reportId)?.name, readyAt: Date.now() + 4000 };
      EXPORTS.unshift(job);
      return r(job);
    }
    if (seg[1]) return r(EXPORTS.find(e => e.id === seg[1]) ?? notFound());
    return r([...EXPORTS]);
  }

  if (seg[0] === 'dashboards') {
    if (seg[1] === 'mine') return r(DASHBOARDS[0] ?? BUILTIN_DASH);
    if (seg[1] === 'widgets') return r(widgetData(seg[2]!, String(body.dashboardId)));
    if (seg.length === 1 && method === 'GET') return r(DASHBOARDS);
    if (seg.length === 1 && method === 'POST') { const d = { ...(body as unknown as DashboardRow), id: uid(), ownerUserId: 'me', version: 1, source: 'personal' as const }; DASHBOARDS.push(d); return r(d); }
    const d = DASHBOARDS.find(x => x.id === seg[1]) ?? notFound();
    if (method === 'GET') return r(d);
    if (method === 'PUT') { Object.assign(d, body, { version: (d.version ?? 1) + 1 }); return r(d); }
    if (method === 'DELETE') { DASHBOARDS.splice(DASHBOARDS.indexOf(d), 1); return r(undefined); }
  }
  return notFound();
}
