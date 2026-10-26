/** Unit tests for the pure permission compiler (ADR-0005). No DB. */
import { describe, expect, it } from 'vitest';
import {
  compile, CompileInput, computeVisibility, expandScope, mergeFieldAccess, RegistryEntry, ScopeNode,
} from '../src/modules/permissions/compiler';
import { scopeCondition, ScopeService } from '../src/modules/permissions/scope.service';
import { fieldsOf } from '../src/modules/permissions/registry.service';
import { levelLabel } from '../src/modules/permissions/settings.util';
import { labelIds } from '../src/modules/permissions/permissions-admin.service';
import { resolveLocationView } from '../src/modules/permissions/locations.controller';
import { resolveUserView } from '../src/modules/identity/users/users.service';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

const e = (key: string, extra: Partial<RegistryEntry> = {}): RegistryEntry => {
  const [tab, rest] = key.split(':');
  return {
    key, kind: rest ? (rest.startsWith('view.') ? 'view' : 'action') : 'tab', tabKey: tab!, label: key, description: null, group: null,
    requiresFeature: null, requiresSetting: null, sortOrder: 0, source: 'platform', ...extra,
  };
};

const REGISTRY: RegistryEntry[] = [
  e('admin.users'), e('admin.users:action.view'), e('admin.users:action.add'), e('admin.users:view.active'),
  e('config.forms', { requiresFeature: 'form_builder' }), e('config.forms:action.view', { requiresFeature: 'form_builder' }),
  e('indent', { requiresSetting: 'flow.indent.enabled' }), e('indent:action.view'), e('indent:action.add'),
  // Entry needing a feature on an otherwise visible tab.
  e('admin.users:action.export', { requiresFeature: 'reports' }),
];

const base = (over: Partial<CompileInput> = {}): CompileInput => ({
  isTenantAdmin: false, registry: REGISTRY, features: [], settings: { 'flow.indent.enabled': true },
  roleGrants: [], userGrants: [], roleFieldAccess: [], userFieldAccess: [], scopeRows: [], nodes: [], version: 3, ...over,
});

describe('permission compiler', () => {
  it('unions grants across roles and adds the tab key when its view action is held', () => {
    const { perms } = compile(base({
      roleGrants: [
        { key: 'admin.users:action.view', effect: 'allow', roleName: 'A' },
        { key: 'indent:action.add', effect: 'allow', roleName: 'B' },
      ],
    }));
    expect(perms.keys).toEqual(['admin.users', 'admin.users:action.view', 'indent:action.add']);
    expect(perms.version).toBe(3);
  });

  it('deny wins over any allow (user deny, role deny)', () => {
    const { perms, explain } = compile(base({
      roleGrants: [
        { key: 'admin.users:action.view', effect: 'allow', roleName: 'A' },
        { key: 'admin.users:action.add', effect: 'allow', roleName: 'A' },
        { key: 'indent:action.view', effect: 'allow', roleName: 'A' },
        { key: 'indent:action.view', effect: 'deny', roleName: 'B' },
      ],
      userGrants: [{ key: 'admin.users:action.add', effect: 'deny' }, { key: 'admin.users:view.active', effect: 'allow' }],
    }));
    expect(perms.keys).toEqual(['admin.users', 'admin.users:action.view', 'admin.users:view.active']);
    const add = explain.find(x => x.key === 'admin.users:action.add')!;
    expect(add).toEqual({ key: 'admin.users:action.add', granted: false, sources: ['role:A', 'user:deny'] });
    expect(explain.find(x => x.key === 'indent:action.view')!.sources).toEqual(['role:A', 'role:B:deny']);
  });

  it('tenant admin gets every visible key and no field/scope restrictions', () => {
    const { perms, explain } = compile(base({
      isTenantAdmin: true, features: ['form_builder'],
      userGrants: [{ key: 'admin.users:action.add', effect: 'deny' }],
      roleFieldAccess: [{ formKey: 'user', fieldKey: 'phone', mode: 'hidden' }],
    }));
    expect(perms.keys).toEqual([
      'admin.users', 'admin.users:action.add', 'admin.users:action.view', 'admin.users:view.active',
      'config.forms', 'config.forms:action.view', 'indent', 'indent:action.add', 'indent:action.view',
    ]);
    expect(perms.fieldAccess).toEqual({});
    expect(perms.scope).toEqual({ allNodes: true, nodeIds: [] });
    expect(explain.find(x => x.key === 'admin.users:action.add')!.sources[0]).toBe('tenant_admin');
  });

  it('plan-hidden keys are never effective, even when granted (and not for admins)', () => {
    const grants = [
      { key: 'config.forms:action.view', effect: 'allow' as const, roleName: 'A' },
      { key: 'admin.users:action.export', effect: 'allow' as const, roleName: 'A' },
    ];
    expect(compile(base({ roleGrants: grants })).perms.keys).toEqual([]);
    const admin = compile(base({ isTenantAdmin: true, roleGrants: grants })).perms.keys;
    expect(admin).not.toContain('config.forms:action.view');
    expect(admin).not.toContain('admin.users:action.export');
    // With the feature, the same grants become effective.
    expect(compile(base({ roleGrants: grants, features: ['form_builder', 'reports'] })).perms.keys)
      .toEqual(['admin.users:action.export', 'config.forms', 'config.forms:action.view']);
  });

  it('a flow setting that is off hides the whole tab (and its keys)', () => {
    const grants = [{ key: 'indent:action.view', effect: 'allow' as const }];
    expect(compile(base({ userGrants: grants })).perms.keys).toEqual(['indent', 'indent:action.view']);
    const off = compile(base({ userGrants: grants, settings: { 'flow.indent.enabled': false } }));
    expect(off.perms.keys).toEqual([]);
    expect(off.visibility.hiddenTabs).toEqual(['config.forms', 'indent']);
    expect(off.visibility.hiddenBySetting.has('indent:action.add')).toBe(true);
    expect(off.visibility.hiddenByFeature.has('config.forms:action.view')).toBe(true);
  });

  it('entries whose tab is missing from the registry are never visible', () => {
    const v = computeVisibility([e('orphan:action.view')], [], {});
    expect(v.visible).toEqual([]);
    expect(v.hiddenByFeature.has('orphan:action.view')).toBe(true);
  });

  it('field access: roles most-restrictive, user row overrides (incl. editable)', () => {
    const fa = mergeFieldAccess(
      [
        { formKey: 'item', fieldKey: 'price', mode: 'readonly' },
        { formKey: 'item', fieldKey: 'price', mode: 'hidden' },
        { formKey: 'item', fieldKey: 'cost', mode: 'hidden' },
        { formKey: 'item', fieldKey: 'hsn', mode: 'readonly' },
        { formKey: 'vendor', fieldKey: 'pan', mode: 'readonly' },
        { formKey: 'vendor', fieldKey: 'x', mode: 'editable' }, // invalid on roles: ignored
      ],
      [
        { formKey: 'item', fieldKey: 'cost', mode: 'editable' },
        { formKey: 'item', fieldKey: 'hsn', mode: 'hidden' },
        { formKey: 'vendor', fieldKey: 'gstin', mode: 'readonly' },
      ],
    );
    expect(fa).toEqual({ item: { price: 'hidden', hsn: 'hidden' }, vendor: { pan: 'readonly', gstin: 'readonly' } });
    // Readonly after hidden must not loosen it.
    expect(mergeFieldAccess([{ formKey: 'f', fieldKey: 'a', mode: 'hidden' }, { formKey: 'f', fieldKey: 'a', mode: 'readonly' }], []))
      .toEqual({ f: { a: 'hidden' } });
  });

  describe('scope expansion', () => {
    const N = (id: string, path: string, isActive = true): ScopeNode => ({ id, parentId: null, path, isActive });
    const nodes = [
      N('pune', 'n1'), N('store', 'n1.n2'), N('binA', 'n1.n2.n3'), N('binB', 'n1.n2.n4', false), N('chennai', 'n9'),
    ];

    it('includes descendants when requested and excludes inactive nodes', () => {
      const s = expandScope([{ allNodes: false, nodeId: 'pune', includeDescendants: true, tabKey: null }], nodes);
      expect(s).toEqual({ all: false, nodeIds: ['binA', 'pune', 'store'], subtreePaths: ['n1'], exactPaths: [] });
    });

    it('a node without descendants is just that node (exact path)', () => {
      const s = expandScope([{ allNodes: false, nodeId: 'store', includeDescendants: false, tabKey: null }], nodes);
      expect(s).toEqual({ all: false, nodeIds: ['store'], subtreePaths: [], exactPaths: ['n1.n2'] });
    });

    it('collapses nested/redundant grants and honours all-nodes', () => {
      const s = expandScope([
        { allNodes: false, nodeId: 'pune', includeDescendants: true, tabKey: null },
        { allNodes: false, nodeId: 'store', includeDescendants: true, tabKey: null },
        { allNodes: false, nodeId: 'binA', includeDescendants: false, tabKey: null },
        { allNodes: false, nodeId: 'binB', includeDescendants: false, tabKey: null }, // inactive: not in nodeIds
        { allNodes: false, nodeId: 'gone', includeDescendants: true, tabKey: null },  // deleted node: ignored
      ], nodes);
      expect(s.subtreePaths).toEqual(['n1']);
      expect(s.exactPaths).toEqual([]);
      expect(s.nodeIds).toEqual(['binA', 'pune', 'store']);
      expect(expandScope([{ allNodes: true, nodeId: null, includeDescendants: true, tabKey: null }], nodes).all).toBe(true);
    });

    it('tab rows replace the default rows for that tab; no rows = nothing', () => {
      const { perms } = compile(base({
        nodes,
        scopeRows: [
          { allNodes: false, nodeId: 'pune', includeDescendants: true, tabKey: null },
          { allNodes: false, nodeId: 'chennai', includeDescendants: false, tabKey: 'indent' },
        ],
      }));
      expect(perms.scope).toEqual({ allNodes: false, nodeIds: ['binA', 'pune', 'store'] });
      expect(perms.scopes.indent!.nodeIds).toEqual(['chennai']);
      const svc = new ScopeService();
      expect(svc.nodeFilter(perms, 'indent')).toEqual({ paths: [], exactPaths: ['n9'], nodeIds: ['chennai'] });
      expect(svc.nodeFilter(perms, 'admin.locations')).toEqual({ paths: ['n1'], exactPaths: [], nodeIds: ['binA', 'pune', 'store'] });
      expect(svc.nodeIds(perms, null)).toEqual(['binA', 'pune', 'store']);
      expect(compile(base()).perms.scope).toEqual({ allNodes: false, nodeIds: [] });
    });
  });
});

describe('ScopeService helpers', () => {
  const svc = new ScopeService();
  it('fails closed without permissions and supports bare MyPermissions', () => {
    expect(svc.nodeFilter(undefined, 'x')).toEqual({ paths: [], exactPaths: [], nodeIds: [] });
    expect(svc.nodeFilter({ keys: [], scope: { allNodes: true, nodeIds: [] }, fieldAccess: {}, version: 1 }, 'x')).toEqual({ all: true });
    expect(svc.nodeIds({ keys: [], scope: { allNodes: false, nodeIds: ['a'] }, fieldAccess: {}, version: 1 }, null)).toEqual(['a']);
    expect(svc.nodeIds({ keys: [], scope: { allNodes: true, nodeIds: [] }, fieldAccess: {}, version: 1 }, null)).toBe('all');
  });

  it('contains() matches subtree and exact paths', () => {
    const f = { paths: ['n1'], exactPaths: ['n9.n8'] };
    expect(svc.contains(f, 'n1')).toBe(true);
    expect(svc.contains(f, 'n1.n2')).toBe(true);
    expect(svc.contains(f, 'n10')).toBe(false);
    expect(svc.contains(f, 'n9.n8')).toBe(true);
    expect(svc.contains(f, 'n9.n8.n7')).toBe(false);
    expect(svc.contains({ all: true }, 'x')).toBe(true);
  });

  it('compiles the SQL condition (all / none / subtree / subtree + exact)', () => {
    const db = new Kysely<{ t: { path: string } }>({ dialect: new PostgresDialect({ pool: new Pool({ max: 1 }) }) });
    const q = (f: Parameters<typeof scopeCondition>[1]) => db.selectFrom('t').selectAll().where(svc.where('t.path', f)).compile();
    expect(q({ all: true }).sql).toContain('where true');
    expect(q({ paths: [] }).sql).toContain('where false');
    const one = q({ paths: ['n1'] });
    expect(one.sql).toContain('"t"."path" <@ ANY($1::ltree[])');
    expect(one.parameters).toEqual([['n1']]);
    const both = q({ paths: ['n1'], exactPaths: ['n2'] });
    expect(both.sql).toContain('OR "t"."path" = ANY($2::ltree[])');
    expect(q({ paths: [], exactPaths: ['n2'] }).sql).toContain('"t"."path" = ANY($1::ltree[])');
    void db.destroy();
  });
});

describe('registry / settings / view helpers', () => {
  it('fieldsOf lists data fields and grid columns, skipping layout and removed', () => {
    expect(fieldsOf({
      fields: [
        { key: 'code', type: 'text', label: 'Code', system: true },
        { key: 's1', type: 'section', label: 'Main' },
        { key: 'old', type: 'text', label: 'Old', removed: true },
        { key: 'lines', type: 'grid', label: 'Lines', columns: [{ key: 'qty', type: 'number', label: 'Qty' }, { key: 'gone', type: 'text', removed: true }] },
        { type: 'text' },
      ],
    })).toEqual([
      { key: 'code', label: 'Code', system: true },
      { key: 'lines', label: 'Lines', system: false },
      { key: 'lines.qty', label: 'Lines › Qty', system: false },
    ]);
    expect(fieldsOf(null)).toEqual([]);
    expect(fieldsOf({ fields: 'nope' })).toEqual([]);
  });

  it('levelLabel uses depth-1 and reuses the last level', () => {
    const levels = ['Plant', 'Store', 'Bin'];
    expect(levelLabel(levels, 1)).toBe('Plant');
    expect(levelLabel(levels, 3)).toBe('Bin');
    expect(levelLabel(levels, 7)).toBe('Bin');
    expect(levelLabel([], 2)).toBe('Location');
  });

  it('labelIds turns an ltree path back into node ids', () => {
    expect(labelIds('n0192a5b0c1d27000800000000000000a.n0192a5b0c1d27000800000000000000b')).toEqual([
      '0192a5b0-c1d2-7000-8000-00000000000a', '0192a5b0-c1d2-7000-8000-00000000000b',
    ]);
  });

  it('views: default = first permitted, missing view → 403', () => {
    const P = (...keys: string[]) => ({ keys, scope: { allNodes: false, nodeIds: [] }, fieldAccess: {}, version: 0 });
    expect(resolveUserView({}, P('admin.users:view.active', 'admin.users:view.inactive'))).toBe('active');
    expect(resolveUserView({}, P('admin.users:view.inactive'))).toBe('inactive');
    expect(resolveUserView({ active: false }, P('admin.users:view.inactive'))).toBe('inactive');
    expect(() => resolveUserView({ view: 'inactive' }, P('admin.users:view.active'))).toThrow(/inactive/);
    expect(() => resolveUserView({}, P())).toThrow();

    expect(resolveLocationView(undefined, P('admin.locations:view.inactive'), false)).toBe('inactive');
    expect(resolveLocationView('all', P('admin.locations:view.inactive', 'admin.locations:view.active'), false)).toBe('all');
    expect(() => resolveLocationView('all', P('admin.locations:view.active'), false)).toThrow();
    expect(resolveLocationView(undefined, P(), true)).toBe('active');
    expect(() => resolveLocationView('inactive', P(), true)).toThrow();
    expect(() => resolveLocationView(undefined, P(), false)).toThrow();
  });
});
