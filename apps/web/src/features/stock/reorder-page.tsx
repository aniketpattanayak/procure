'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import type { DocumentRow } from '@procure/schema';
import {
  Badge, Button, Checkbox, cn, Dialog, DialogContent, EmptyState, FormField, Input, Skeleton, Switch, Tabs, TabsContent, TabsList, TabsTrigger, toast,
} from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, FilePlus2, Pencil, Plus, Repeat, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { docKeys, docsApi } from '@/features/documents/api';
import { dec, fmtQty, isDecimal } from '@/features/documents/decimal';
import { MasterPicker, type PickedOption } from '@/features/procurement/components/master-picker';
import { useProcurementFlow } from '@/features/procurement/flow';
import { t } from '@/i18n';
import { applyProblemToForm, isApiError } from '@/lib/api';
import { fmtRelative } from '@/lib/format';
import { usePermissions } from '@/lib/permissions';
import { STOCK_PERM, stockApi, stockKeys, type ReorderRuleRow, type ReorderSuggestion } from './api';
import { LocationSelect, Qty } from './components';

type Tab = 'suggestions' | 'rules';

/** Re-order: items below minimum with suggested quantities (raise indents), and the rules themselves. */
export function ReorderPage() {
  const p = usePermissions();
  const canRules = p.has(STOCK_PERM.reorder);
  const [tab, setTab] = useState<Tab>('suggestions');
  const [node, setNode] = useState('');
  return (
    <PageBody>
      <PageHeader
        back={<Link href="/stock" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" aria-hidden />{t('stock.title')}</Link>}
        title={t('stock.reorder.title')}
        description={t('stock.reorder.hint')}
        actions={<LocationSelect value={node} onChange={setNode} allLabel={t('topbar.allLocations')} label={t('stock.filter.location')} className="w-full sm:w-52" testId="reorder-location" />}
      />
      <Tabs value={tab} onValueChange={v => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="suggestions" data-testid="reorder-tab-suggestions">{t('stock.reorder.suggestions')}</TabsTrigger>
          {canRules && <TabsTrigger value="rules" data-testid="reorder-tab-rules">{t('stock.reorder.rules')}</TabsTrigger>}
        </TabsList>
        <TabsContent value="suggestions" className="pt-4"><Suggestions node={node} /></TabsContent>
        {canRules && <TabsContent value="rules" className="pt-4"><Rules node={node} /></TabsContent>}
      </Tabs>
    </PageBody>
  );
}

/* ------------------------------------------------------------------ suggestions */

function Suggestions({ node }: { node: string }) {
  const qc = useQueryClient();
  const p = usePermissions();
  const flow = useProcurementFlow();
  const canIndent = p.has(STOCK_PERM.indentAdd) && flow.indentEnabled;
  const q = useQuery({ queryKey: stockKeys.reorder(node || undefined), queryFn: () => stockApi.reorder(node || undefined), retry: false });
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<DocumentRow[]>([]);

  const rows = q.data ?? [];
  const groups = useMemo(() => {
    const m = new Map<string, { node: ReorderSuggestion['node']; rows: ReorderSuggestion[] }>();
    for (const r of rows) { const g = m.get(r.node.id) ?? { node: r.node, rows: [] }; g.rows.push(r); m.set(r.node.id, g); }
    return [...m.values()];
  }, [rows]);
  const chosen = rows.filter(r => picked[r.ruleId] !== undefined);
  const bad = chosen.filter(r => !isDecimal(picked[r.ruleId]!) || !dec.gt0(picked[r.ruleId]!));

  const toggle = (r: ReorderSuggestion, on: boolean) => setPicked(x => { const n = { ...x }; if (on) n[r.ruleId] = r.suggestedQty; else delete n[r.ruleId]; return n; });

  const createIndents = async () => {
    setError(null);
    if (bad.length) { setError(t('stock.err.qty')); return; }
    setSaving(true);
    const out: DocumentRow[] = [];
    try {
      // Indent location is a header field, so one draft indent per location.
      for (const g of groups) {
        const lines = g.rows.filter(r => picked[r.ruleId] !== undefined);
        if (!lines.length) continue;
        out.push(await docsApi.create('indent', {
          values: { location: g.node.id, purpose: t('stock.reorder.purpose') },
          lines: lines.map(r => ({ values: { item: r.item.id, qty: dec.norm(picked[r.ruleId]!), remarks: t('stock.reorder.remark', { available: r.available, min: r.minQty }) } })),
        }));
      }
      setPicked({});
      toast.success(t('stock.reorder.created', { n: out.length }));
    } catch (e) {
      setError(isApiError(e) ? e.message : String(e));
    } finally {
      setCreated(c => [...out, ...c]);
      setSaving(false);
      if (out.length) void qc.invalidateQueries({ queryKey: docKeys.all('indent') });
    }
  };

  if (q.isLoading) return <Skeleton className="h-48 w-full" />;
  if (q.isError) return <InlineAlert>{isApiError(q.error) ? q.error.message : t('stock.loadFailed')}</InlineAlert>;
  return (
    <div className="space-y-3">
      {created.length > 0 && (
        <InlineAlert tone="success" data-testid="reorder-created">
          <p className="flex items-center gap-2 font-medium"><CheckCircle2 className="size-4" aria-hidden />{t('stock.reorder.created', { n: created.length })}</p>
          <ul className="mt-1 space-y-0.5">{created.map(d => <li key={d.id}><Link className="underline-offset-2 hover:underline" href={`/docs/indent/${d.id}`}>{d.number ?? t('stock.reorder.draftIndent', { n: d.lines.length })}</Link></li>)}</ul>
        </InlineAlert>
      )}
      {rows.length === 0 ? <EmptyState icon={<Repeat />} title={t('stock.reorder.none')} description={t('stock.reorder.noneHint')} /> : (
        <>
          {groups.map(g => (
            <section key={g.node.id} className="overflow-hidden rounded-lg border border-border" aria-label={g.node.name}>
              <h2 className="border-b border-border bg-subtle px-3 py-2 text-sm font-semibold">{g.node.name} <span className="font-normal text-fg-subtle">{g.node.code}</span></h2>
              <ul className="divide-y divide-border">
                {g.rows.map(r => {
                  const on = picked[r.ruleId] !== undefined;
                  return (
                    <li key={r.ruleId} className={cn('flex flex-wrap items-center gap-3 px-3 py-2.5', on && 'bg-accent-soft/40')} data-testid={`reorder-row-${r.item.code}`}>
                      {canIndent && <Checkbox checked={on} onCheckedChange={c => toggle(r, c === true)} aria-label={t('stock.reorder.pick', { item: r.item.name })} data-testid={`reorder-pick-${r.item.code}`} />}
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{r.item.name} <span className="font-normal text-fg-subtle">{r.item.code}</span>{r.autoIndent && <Badge tone="accent" className="ml-2">{t('stock.reorder.auto')}</Badge>}</p>
                        <p className="text-sm text-fg-muted">{t('stock.reorder.facts', { available: fmtQty(r.available), min: fmtQty(r.minQty), reorder: fmtQty(r.reorderQty) })}{r.maxQty ? ` · ${t('stock.reorder.max', { qty: fmtQty(r.maxQty) })}` : ''}</p>
                      </div>
                      {on ? (
                        <Input inputMode="decimal" className="h-8 w-28 text-right" value={picked[r.ruleId]} onChange={e => setPicked(x => ({ ...x, [r.ruleId]: e.target.value }))} aria-label={t('stock.reorder.qtyFor', { item: r.item.name })} data-testid={`reorder-qty-${r.item.code}`} />
                      ) : <span className="text-sm tabular-nums">{t('stock.reorder.suggest', { qty: fmtQty(r.suggestedQty) })}</span>}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {error && <InlineAlert>{error}</InlineAlert>}
          {canIndent ? (
            <div className="flex justify-end">
              <Button onClick={createIndents} disabled={!chosen.length} loading={saving} data-testid="reorder-create-indent"><FilePlus2 aria-hidden />{t('stock.reorder.createIndent', { n: chosen.length })}</Button>
            </div>
          ) : <p className="text-sm text-fg-muted">{t('stock.reorder.noIndentPerm')}</p>}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ rules */

function Rules({ node }: { node: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: stockKeys.rules(node || undefined), queryFn: () => stockApi.rules(node || undefined), retry: false });
  const [editing, setEditing] = useState<ReorderRuleRow | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ReorderRuleRow | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: stockKeys.all });

  if (q.isLoading) return <Skeleton className="h-48 w-full" />;
  if (q.isError) return <InlineAlert>{isApiError(q.error) ? q.error.message : t('stock.loadFailed')}</InlineAlert>;
  const rules = q.data ?? [];
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><Button onClick={() => setEditing('new')} data-testid="rule-new"><Plus aria-hidden />{t('stock.rule.new')}</Button></div>
      {rules.length === 0 ? <EmptyState icon={<Repeat />} title={t('stock.rule.none')} description={t('stock.rule.noneHint')} /> : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[40rem] text-sm" data-testid="rules-table">
            <caption className="sr-only">{t('stock.reorder.rules')}</caption>
            <thead className="bg-subtle text-left text-xs text-fg-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">{t('stock.col.item')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('stock.col.location')}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('stock.rule.min')}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('stock.rule.reorderQty')}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('stock.rule.max')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('stock.rule.flags')}</th>
                <th scope="col" className="px-3 py-2"><span className="sr-only">{t('common.actions')}</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rules.map(r => (
                <tr key={r.id} className={cn(!r.isActive && 'text-fg-subtle')} data-testid={`rule-row-${r.item.code}-${r.node.code}`}>
                  <td className="px-3 py-2"><span className="font-medium">{r.item.name}</span> <span className="text-fg-subtle">{r.item.code}</span></td>
                  <td className="px-3 py-2">{r.node.name}</td>
                  <td className="px-3 py-2 text-right"><Qty value={r.minQty} /></td>
                  <td className="px-3 py-2 text-right"><Qty value={r.reorderQty} /></td>
                  <td className="px-3 py-2 text-right">{r.maxQty ? <Qty value={r.maxQty} /> : '—'}</td>
                  <td className="space-x-1 px-3 py-2">
                    {!r.isActive && <Badge tone="neutral">{t('stock.rule.inactive')}</Badge>}
                    {r.autoIndent && <Badge tone="accent">{t('stock.reorder.auto')}</Badge>}
                    {r.lastAlertAt && <span className="text-xs text-fg-subtle">{t('stock.rule.lastAlert', { when: fmtRelative(r.lastAlertAt) })}</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(r)} aria-label={t('stock.rule.editFor', { item: r.item.name })} data-testid={`rule-edit-${r.item.code}`}><Pencil aria-hidden /></Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(r)} aria-label={t('stock.rule.deleteFor', { item: r.item.name })}><Trash2 aria-hidden /></Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <RuleDialog rule={editing === 'new' ? null : editing} defaultNode={node} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      <ConfirmDialog open={!!deleting} onOpenChange={o => { if (!o) setDeleting(null); }} tone="danger" title={t('stock.rule.deleteTitle')}
        description={deleting ? t('stock.rule.deleteBody', { item: deleting.item.name, node: deleting.node.name }) : undefined} confirmLabel={t('stock.rule.delete')}
        onConfirm={async () => { if (deleting) { await stockApi.deleteRule(deleting.id); refresh(); toast.success(t('stock.rule.deleted')); } }} />
    </div>
  );
}

const decimalStr = (msg: string) => z.string().trim().refine(isDecimal, msg);
function ruleSchema() {
  return z.object({
    item: z.object({ id: z.string(), name: z.string(), code: z.string().optional() }).nullable().refine(v => !!v, t('stock.rule.err.item')),
    nodeId: z.string().min(1, t('stock.rule.err.node')),
    minQty: decimalStr(t('stock.err.qty')),
    reorderQty: decimalStr(t('stock.err.qty')).refine(dec.gt0, t('stock.rule.err.reorder')),
    maxQty: z.string().trim().refine(v => v === '' || isDecimal(v), t('stock.err.qty')),
    autoIndent: z.boolean(),
    isActive: z.boolean(),
  }).refine(v => v.maxQty === '' || dec.cmp(v.maxQty, v.minQty) >= 0, { path: ['maxQty'], message: t('stock.rule.err.max') });
}
type RuleForm = { item: PickedOption | null; nodeId: string; minQty: string; reorderQty: string; maxQty: string; autoIndent: boolean; isActive: boolean };

function RuleDialog({ rule, defaultNode, onClose, onSaved }: { rule: ReorderRuleRow | null; defaultNode: string; onClose: () => void; onSaved: () => void }) {
  const [rootError, setRootError] = useState<string | null>(null);
  const form = useForm<RuleForm>({
    resolver: zodResolver(ruleSchema()) as never,
    defaultValues: rule
      ? { item: rule.item, nodeId: rule.node.id, minQty: rule.minQty, reorderQty: rule.reorderQty, maxQty: rule.maxQty ?? '', autoIndent: rule.autoIndent, isActive: rule.isActive }
      : { item: null, nodeId: defaultNode, minQty: '', reorderQty: '', maxQty: '', autoIndent: false, isActive: true },
  });
  const { errors, isSubmitting } = form.formState;
  const submit = form.handleSubmit(async v => {
    setRootError(null);
    const body = { itemId: v.item!.id, nodeId: v.nodeId, minQty: dec.norm(v.minQty), reorderQty: dec.norm(v.reorderQty), ...(v.maxQty ? { maxQty: dec.norm(v.maxQty) } : {}), autoIndent: v.autoIndent, isActive: v.isActive };
    try {
      if (rule) await stockApi.updateRule(rule.id, body); else await stockApi.createRule(body);
      toast.success(t('stock.rule.saved'));
      onSaved();
    } catch (e) {
      const map: Record<string, keyof RuleForm> = { itemId: 'item', nodeId: 'nodeId', minQty: 'minQty', reorderQty: 'reorderQty', maxQty: 'maxQty' };
      if (isApiError(e)) e.errors.forEach(fe => { fe.path = map[fe.path] ?? fe.path; });
      setRootError(applyProblemToForm(e, form.setError as never, Object.keys(map).map(k => map[k]!)));
    }
  });
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent title={rule ? t('stock.rule.edit') : t('stock.rule.new')} closeLabel={t('common.close')} data-testid="rule-dialog"
        footer={<><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button onClick={submit} loading={isSubmitting} data-testid="rule-save">{t('common.saveChanges')}</Button></>}>
        <form className="space-y-4" onSubmit={submit} noValidate>
          <Controller control={form.control} name="item" render={({ field }) => (
            <FormField label={t('stock.col.item')} required error={errors.item?.message}>
              <MasterPicker masterKey="item" value={field.value} onChange={field.onChange} ariaLabel={t('stock.col.item')} invalid={!!errors.item} testId="rule-item" />
            </FormField>
          )} />
          <Controller control={form.control} name="nodeId" render={({ field }) => (
            <FormField label={t('stock.col.location')} required error={errors.nodeId?.message}>
              <LocationSelect value={field.value} onChange={field.onChange} label={t('stock.col.location')} className="h-9 w-full" testId="rule-node" />
            </FormField>
          )} />
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label={t('stock.rule.min')} required error={errors.minQty?.message}><Input inputMode="decimal" {...form.register('minQty')} data-testid="rule-min" /></FormField>
            <FormField label={t('stock.rule.reorderQty')} required error={errors.reorderQty?.message}><Input inputMode="decimal" {...form.register('reorderQty')} data-testid="rule-reorder" /></FormField>
            <FormField label={t('stock.rule.max')} error={errors.maxQty?.message}><Input inputMode="decimal" {...form.register('maxQty')} data-testid="rule-max" /></FormField>
          </div>
          <Controller control={form.control} name="autoIndent" render={({ field }) => (
            <label className="flex items-center justify-between gap-3 text-sm"><span>{t('stock.rule.autoIndent')}<span className="block text-xs text-fg-subtle">{t('stock.rule.autoIndentHint')}</span></span><Switch checked={field.value} onCheckedChange={field.onChange} /></label>
          )} />
          <Controller control={form.control} name="isActive" render={({ field }) => (
            <label className="flex items-center justify-between gap-3 text-sm"><span>{t('stock.rule.active')}</span><Switch checked={field.value} onCheckedChange={field.onChange} /></label>
          )} />
          {rootError && <InlineAlert>{rootError}</InlineAlert>}
        </form>
      </DialogContent>
    </Dialog>
  );
}
