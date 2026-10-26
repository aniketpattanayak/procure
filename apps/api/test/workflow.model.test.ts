/** Pure workflow model: stage groups, parallel quantity arithmetic (Q = max(pending + held)), vote merging, validation. */
import { scopeFromDefinition } from '@procure/formula';
import { describe, expect, it } from 'vitest';
import {
  cell, clearLine, D, drainGroup, enter, fmt, groupQty, groupsOf, hasQty, heldMeasure, inWorkflow, LineQty, mergeVotes, releasable,
  removeFromSiblings,
} from '../src/modules/workflow/model';
import { validateDefinition } from '../src/modules/workflow/validate';
import { parseDefinition } from '../src/modules/workflow';

describe('workflow model', () => {
  it('groups consecutive stages sharing a parallelGroup', () => {
    const g = groupsOf([{ key: 'a' }, { key: 'b', parallelGroup: 'p' }, { key: 'c', parallelGroup: 'p' }, { key: 'd' }, { key: 'e', parallelGroup: 'p' }]);
    expect(g.map(x => x.stages)).toEqual([['a'], ['b', 'c'], ['d'], ['e']]);
    expect(g.map(x => x.index)).toEqual([0, 1, 2, 3]);
  });

  it('parallel arithmetic: eager release keeps Q = max(pending + held)', () => {
    const g = { index: 0, key: 'p', stages: ['x', 'y'] };
    const l: LineQty = new Map();
    enter(l, ['x', 'y'], D(100));
    expect(fmt(groupQty(l, g))).toBe('100');
    // x approves 100: nothing releasable until y decides
    let q = groupQty(l, g);
    cell(l, 'x').p = D(0);
    expect(fmt(releasable(l, g, q))).toBe('0');
    // y approves 60, holds 10, rejects 30
    q = groupQty(l, g);
    const y = cell(l, 'y');
    y.p = D(0); y.h = D(10);
    removeFromSiblings(l, g, 'y', D(30));
    const m = releasable(l, g, q.minus(30));
    expect(fmt(m)).toBe('60');
    expect(fmt(groupQty(l, g))).toBe('10');
    expect(fmt(heldMeasure(l, [g]))).toBe('10');
    expect(fmt(inWorkflow(l, [g]))).toBe('10');
    // siblings lose rejected qty from pending first, then held
    const l2: LineQty = new Map([['x', { p: D(5), h: D(5) }], ['y', { p: D(10), h: D(0) }]]);
    removeFromSiblings(l2, g, 'y', D(7));
    expect([fmt(l2.get('x')!.p), fmt(l2.get('x')!.h)]).toEqual(['0', '3']);
    removeFromSiblings(l2, g, 'y', D(0));
    expect(fmt(drainGroup(l2, g).qty)).toBe('10');
    expect(hasQty(l2)).toBe(false);
    enter(l2, ['x'], D(0));
    enter(l2, ['x'], D(2));
    expect(hasQty(l2)).toBe(true);
    clearLine(l2);
    expect(hasQty(l2)).toBe(false);
  });

  it('merges quorum votes: min approve, max reject (bounded), rest held; decimals exact', () => {
    const p = D('10.5');
    expect(Object.values(mergeVotes(p, [{ approve: D('10.5'), reject: D(0) }, { approve: D('8.25'), reject: D('2.25') }])).map(fmt)).toEqual(['8.25', '2.25', '0']);
    expect(Object.values(mergeVotes(p, [{ approve: D('5'), reject: D(0) }, { approve: D('10.5'), reject: D(0) }])).map(fmt)).toEqual(['5', '0', '5.5']);
    expect(Object.values(mergeVotes(p, [])).map(fmt)).toEqual(['0', '10.5', '0']);
    expect(fmt(D('0.1').plus('0.2'))).toBe('0.3');
    expect(fmt(D('1.500'))).toBe('1.5');
  });

  it('validates a clean definition with no issues', () => {
    const header = { fields: [{ key: 'total_amount', type: 'currency', label: 'T' }, { key: 'approver', type: 'lookup', label: 'A', source: { kind: 'user' } }] };
    const scope = scopeFromDefinition({ fields: [...header.fields, { key: 'lines', type: 'grid', label: 'L', columns: [{ key: 'qty', type: 'decimal', label: 'Q' }] }] } as never);
    const def = parseDefinition({ stages: [
      { key: 'a', name: 'A', when: 'total_amount > 5 and SUM(lines.qty) > 1', actors: [{ type: 'field', field: 'approver' }], sla: { hours: 2, escalateTo: { type: 'role', roleId: '00000000-0000-0000-0000-000000000001' } } },
      { key: 'b', name: 'B', parallelGroup: 'g', quorum: 'all', actors: [{ type: 'users', userIds: ['00000000-0000-0000-0000-000000000002'] }], effects: { onReject: [{ effect: 'route_to', stage: 'a' }] } },
      { key: 'c', name: 'C', parallelGroup: 'g', editableLineFields: ['qty'] },
    ] });
    const issues = validateDefinition(def, {
      scope, roleIds: new Set(['00000000-0000-0000-0000-000000000001']), userIds: new Set(['00000000-0000-0000-0000-000000000002']),
      userFields: new Set(['approver']), lineFields: new Set(['qty']), availableEffects: new Set(['route_to']),
    });
    expect(issues).toEqual([]);
    expect(validateDefinition(parseDefinition({ stages: [{ key: 'a', name: 'A', when: 'total_amount' }] }), {
      scope, roleIds: new Set(), userIds: new Set(), userFields: new Set(), lineFields: new Set(), availableEffects: new Set(),
    }).map(i => i.code)).toEqual(['BAD_CONDITION']);
  });
});
