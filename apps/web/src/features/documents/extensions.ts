/**
 * Document screen extension points (additive registry). Feature modules add header actions, banners, aside
 * blocks, tabs, line columns, item-wise list columns and form banners without editing the document pages;
 * `extensions-installed.ts` imports each module's registration once.
 *
 * Two registration styles share one registry:
 *   registerDocExtension(typeKey | '*', { actions?, banner?, aside?, tabs?, lineColumns?, itemColumns?, formBanner? })
 *   registerDocAction({ key, order?, Component })                       // any doc type, header action bar
 *   registerDocTab({ key, order?, label, visible?, Component })          // any doc type, detail tab
 *
 * Pages read the merged view with `docExtension(type)`.
 *
 * NOTE (Phase 6 frontend): this file was accidentally overwritten while the procurement agent was creating it and
 * has been rebuilt from its call sites (doc-detail-page, doc-list-page, doc-form-page, lines-table). If anything
 * of the original API is missing, add it here; keep both styles working.
 */
import type { DocTypeSummary, DocumentLineRow, DocumentRow, ItemListRow } from '@procure/schema';
import { createElement, Fragment, type ComponentType, type ReactNode } from 'react';

// ---------------------------------------------------------------------------------------------- context types

export interface DocExtensionContext {
  doc: DocumentRow;
  docType: DocTypeSummary;
  /** `doc.allowedActions` as a set. */
  allowed: ReadonlySet<string>;
  /** Store a new document row (or just refetch) and invalidate lists. */
  refresh: (next?: DocumentRow) => void;
  /** Line focused via `?line=` or `openTab(..., { lineId })`. */
  focusLineId: string | null;
  openTab: (key: string, opts?: { lineId?: string | null }) => void;
}

export interface DocLineColumn { key: string; label: ReactNode; align?: 'left' | 'right'; cell: (line: DocumentLineRow) => ReactNode }
export interface DocItemColumn { id: string; label: string; width?: number; align?: 'left' | 'right'; defaultVisible?: boolean; cell: (row: ItemListRow) => ReactNode }
export interface DocExtTab { key: string; label: ReactNode; testId?: string; badge?: ReactNode; render: () => ReactNode }
export interface DocFormBannerProps { doc: DocumentRow | null; docType: DocTypeSummary; errors: { path: string; message: string }[]; values: Record<string, unknown> }

export interface DocExtensionDef {
  actions?: (ctx: DocExtensionContext) => ReactNode;
  banner?: (ctx: DocExtensionContext) => ReactNode;
  aside?: (ctx: DocExtensionContext) => ReactNode;
  tabs?: (ctx: DocExtensionContext) => DocExtTab[];
  lineColumns?: (ctx: DocExtensionContext) => DocLineColumn[];
  itemColumns?: (docType: DocTypeSummary) => DocItemColumn[];
  formBanner?: (p: DocFormBannerProps) => ReactNode;
}

// ---------------------------------------------------------------------------------------------- component style

export interface DocExtensionProps { docType: DocTypeSummary; doc: DocumentRow }
export interface DocExtensionGate extends DocExtensionProps { has: (key: string) => boolean; features: ReadonlySet<string> }

export interface DocActionExtension {
  key: string;
  order?: number;
  Component: ComponentType<DocExtensionProps>;
}
export interface DocTabExtension {
  key: string;
  order?: number;
  label: (p: DocExtensionProps) => string;
  /** Hide the tab. Gets `has(permKey)` and plan `features`; supply them via `setDocExtensionGate`. */
  visible?: (g: DocExtensionGate) => boolean;
  Component: ComponentType<DocExtensionProps>;
}

// ---------------------------------------------------------------------------------------------- registry

const defs: { scope: string; def: DocExtensionDef }[] = [];
const actionComps = new Map<string, DocActionExtension>();
const tabComps = new Map<string, DocTabExtension>();
let gate: { has: (key: string) => boolean; features: ReadonlySet<string> } = { has: () => true, features: new Set() };

export function registerDocExtension(scope: string, def: DocExtensionDef) { defs.push({ scope, def }); }
export function registerDocAction(x: DocActionExtension) { actionComps.set(x.key, x); }
export function registerDocTab(x: DocTabExtension) { tabComps.set(x.key, x); }
/** Permission/feature source for component-style `visible` checks (set by a provider that has the session). */
export function setDocExtensionGate(g: typeof gate) { gate = g; }

const byOrder = <T extends { order?: number }>(a: T, b: T) => (a.order ?? 50) - (b.order ?? 50);
export function docActionExtensions(): DocActionExtension[] { return [...actionComps.values()].sort(byOrder); }
export function docTabExtensions(): DocTabExtension[] { return [...tabComps.values()].sort(byOrder); }

const nodes = (list: ReactNode[]) => (list.some(x => x !== null && x !== undefined && x !== false) ? createElement(Fragment, null, ...list) : null);

/** Merged extensions for a document type (type-specific and '*' registrations, plus component-style ones). */
export function docExtension(type: string) {
  const mine = defs.filter(d => d.scope === type || d.scope === '*').map(d => d.def);
  return {
    actions: (ctx: DocExtensionContext): ReactNode => nodes([
      ...mine.map(d => d.actions?.(ctx)),
      ...docActionExtensions().map(a => createElement(a.Component, { key: `ext-${a.key}`, doc: ctx.doc, docType: ctx.docType })),
    ]),
    banner: (ctx: DocExtensionContext): ReactNode => nodes(mine.map(d => d.banner?.(ctx))),
    aside: (ctx: DocExtensionContext): ReactNode => nodes(mine.map(d => d.aside?.(ctx))),
    tabs: (ctx: DocExtensionContext): DocExtTab[] => [
      ...mine.flatMap(d => d.tabs?.(ctx) ?? []),
      ...docTabExtensions()
        .filter(x => !x.visible || x.visible({ doc: ctx.doc, docType: ctx.docType, has: gate.has, features: gate.features }))
        .map<DocExtTab>(x => ({ key: x.key, label: x.label(ctx), testId: `doc-tab-${x.key}`, render: () => createElement(x.Component, { doc: ctx.doc, docType: ctx.docType }) })),
    ],
    lineColumns: (ctx: DocExtensionContext): DocLineColumn[] => mine.flatMap(d => d.lineColumns?.(ctx) ?? []),
    itemColumns: (docType: DocTypeSummary): DocItemColumn[] => mine.flatMap(d => d.itemColumns?.(docType) ?? []),
    formBanner: (p: DocFormBannerProps): ReactNode => nodes(mine.map(d => d.formBanner?.(p))),
  };
}

// ---------------------------------------------------------------------------------------------- list header actions
// Phase 5 (stock web): "create from" entry points on a document type's list page (e.g. GRN → "Receive against PO").
// Appended registry; `doc-list-page` renders `docListActions(type)` next to the "New" button.

export interface DocListActionProps { docType: DocTypeSummary }
const listActionComps: { scope: string; key: string; order?: number; Component: ComponentType<DocListActionProps> }[] = [];

/** Register a header action for the list page of `scope` (a doc type key, or '*'). Re-registering a key replaces it. */
export function registerDocListAction(scope: string, x: { key: string; order?: number; Component: ComponentType<DocListActionProps> }) {
  const i = listActionComps.findIndex(a => a.key === x.key);
  if (i >= 0) listActionComps.splice(i, 1);
  listActionComps.push({ scope, ...x });
}

/** Header actions for a doc type's list page. */
export function docListActions(docType: DocTypeSummary): ReactNode {
  const mine = listActionComps.filter(a => a.scope === docType.key || a.scope === '*').sort(byOrder);
  return mine.length ? createElement(Fragment, null, ...mine.map(a => createElement(a.Component, { key: `list-${a.key}`, docType }))) : null;
}

// ---------------------------------------------------------------------------------------------- approval draft prefill
// Phase 5 (stock web): a module may pre-fill the approval screen's line decision (e.g. GRN gate: reject what the
// receiver counted as rejected). Returns the qty to put in the reject bucket and its reason, or null for the default.

export interface DecisionPrefill { reject: string; reason: string }
const prefills: { scope: string; fn: (doc: DocumentRow, line: DocumentLineRow, stageKey: string, pending: string) => DecisionPrefill | null }[] = [];

export function registerDecisionPrefill(scope: string, fn: (doc: DocumentRow, line: DocumentLineRow, stageKey: string, pending: string) => DecisionPrefill | null) {
  prefills.push({ scope, fn });
}

/** First registered prefill for this document's type that returns a value. */
export function decisionPrefill(doc: DocumentRow, line: DocumentLineRow, stageKey: string, pending: string): DecisionPrefill | null {
  for (const p of prefills) {
    if (p.scope !== doc.docTypeKey && p.scope !== '*') continue;
    const v = p.fn(doc, line, stageKey, pending);
    if (v) return v;
  }
  return null;
}
