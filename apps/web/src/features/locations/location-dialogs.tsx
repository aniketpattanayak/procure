'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { ErrorCode, LocationCreate, type LocationNode } from '@procure/schema';
import { Button, cn, Dialog, DialogContent, FormField, Input, toast } from '@procure/ui';
import { useQueryClient } from '@tanstack/react-query';
import { CornerLeftUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { applyProblemToForm, isApiError } from '@/lib/api';
import { locationKeys, locationsApi } from './api';
import { ancestorIds, buildTree, descendantIds, fullPath, searchVisible, type LocationTree, type TreeNode } from './tree';
import { TreeView } from './tree-view';

const FormSchema = LocationCreate.omit({ parentId: true, custom: true }).extend({ sortOrder: z.coerce.number().int().default(0) });
type FormValues = z.input<typeof FormSchema>;

export function invalidateLocations(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: locationKeys.all });
}

/** Add (parent given or null for top level) or edit (node given). */
export function LocationFormDialog({ open, onOpenChange, parent, node, levelLabel, onSaved }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  parent?: LocationNode | null;
  node?: LocationNode;
  /** Level name of the node being added / edited (e.g. "Store"). */
  levelLabel: string;
  onSaved?: (n: LocationNode) => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<{ msg: string; limit?: boolean } | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: { code: node?.code ?? '', name: node?.name ?? '', sortOrder: node?.sortOrder ?? 0 },
  });
  const { register, handleSubmit, formState: { errors, isSubmitting } } = form;
  const close = (o: boolean) => { if (!o) { form.reset(); setError(null); } onOpenChange(o); };

  const submit = handleSubmit(async raw => {
    const v = FormSchema.parse(raw);
    setError(null);
    try {
      const saved = node
        ? await locationsApi.update(node.id, { code: v.code, name: v.name, sortOrder: v.sortOrder, version: node.version })
        : await locationsApi.create({ parentId: parent?.id ?? null, code: v.code, name: v.name, sortOrder: v.sortOrder });
      toast.success(node ? t('locations.saved') : t('locations.added', { name: saved.name }));
      invalidateLocations(qc);
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      onSaved?.(saved);
      close(false);
    } catch (e) {
      if (isApiError(e) && e.is(ErrorCode.LIMIT_EXCEEDED)) { setError({ msg: e.message, limit: true }); return; }
      const msg = applyProblemToForm(e, form.setError, ['code', 'name', 'sortOrder']);
      if (msg) setError({ msg });
    }
  });

  const title = node
    ? t('locations.edit.title', { name: node.name })
    : parent ? t('locations.add.childTitle', { level: levelLabel, parent: parent.name }) : t('locations.add.rootTitle', { level: levelLabel });

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title={title}
        description={!node && parent ? fullPath(parent).join(' / ') : undefined}
        closeLabel={t('common.close')}
        data-testid={node ? 'location-edit-dialog' : 'location-add-dialog'}
        footer={<>
          <Button variant="secondary" onClick={() => close(false)}>{t('common.cancel')}</Button>
          <Button type="submit" form="location-form" loading={isSubmitting} data-testid="location-submit">{node ? t('common.saveChanges') : t('locations.add.submit', { level: levelLabel })}</Button>
        </>}
      >
        <form id="location-form" onSubmit={submit} noValidate className="space-y-4">
          {error && <InlineAlert tone={error.limit ? 'warning' : 'danger'} data-testid={error.limit ? 'location-limit-error' : 'location-error'}>{error.msg}</InlineAlert>}
          <FormField label={t('locations.field.name')} error={errors.name?.message} required>
            <Input {...register('name')} autoFocus data-testid="location-name" />
          </FormField>
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
            <FormField label={t('locations.field.code')} error={errors.code?.message} hint={t('locations.field.codeHint')} required>
              <Input className="font-mono" autoCapitalize="characters" spellCheck={false} {...register('code')} data-testid="location-code" />
            </FormField>
            <FormField label={t('locations.field.sortOrder')} error={errors.sortOrder?.message}>
              <Input type="number" inputMode="numeric" {...register('sortOrder')} data-testid="location-sort" />
            </FormField>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Move a node under another parent (or to the top level). Its own subtree can't be chosen. */
export function MoveLocationDialog({ open, onOpenChange, node, tree, onMoved }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  node: LocationNode;
  tree: LocationTree;
  onMoved?: (n: LocationNode) => void;
}) {
  const qc = useQueryClient();
  const self = tree.byId.get(node.id);
  const blocked = useMemo(() => {
    const s = self ? descendantIds(self) : new Set<string>();
    s.add(node.id);
    return s;
  }, [self, node.id]);
  const activeTree = useMemo(() => buildTree([...tree.byId.values()].map(x => x.node).filter(n => n.isActive)), [tree]);
  const [target, setTarget] = useState<string | null | undefined>(undefined); // undefined = nothing picked; null = top level
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(self ? ancestorIds(self) : []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const search = useMemo(() => searchVisible(activeTree, q), [activeTree, q]);
  const unchanged = target === (node.parentId ?? null);

  async function submit() {
    if (target === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const moved = await locationsApi.move(node.id, { parentId: target, version: node.version });
      toast.success(t('locations.moved', { name: node.name }));
      invalidateLocations(qc);
      onMoved?.(moved);
      onOpenChange(false);
    } catch (e) {
      setError(isApiError(e) && e.status === 409 ? t('locations.move.conflict') : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pick = (tn: TreeNode) => { if (!blocked.has(tn.id)) setTarget(tn.id); };
  const targetName = target === null ? t('locations.move.topLevel') : target ? activeTree.byId.get(target)?.node.name : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('locations.move.title', { name: node.name })}
        description={t('locations.move.hint')}
        size="lg"
        closeLabel={t('common.close')}
        data-testid="location-move-dialog"
        footer={<>
          <p className="mr-auto self-center text-sm text-fg-muted" role="status">{targetName ? t('locations.move.target', { name: targetName }) : t('locations.move.pick')}</p>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={() => void submit()} disabled={target === undefined || unchanged} loading={busy} data-testid="location-move-submit">{t('locations.move.submit')}</Button>
        </>}
      >
        <div className="space-y-3">
          {error && <InlineAlert>{error}</InlineAlert>}
          <Input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={t('locations.search')} aria-label={t('locations.search')} data-testid="location-move-search" />
          <button
            type="button"
            onClick={() => setTarget(null)}
            aria-pressed={target === null}
            data-testid="location-move-top"
            className={cn('flex h-9 w-full items-center gap-2 rounded px-2 text-left outline-none focus-visible:outline-2 focus-visible:outline-ring', target === null ? 'bg-accent-soft font-medium text-accent' : 'hover:bg-subtle')}
          >
            <CornerLeftUp className="size-4" aria-hidden />{t('locations.move.topLevel')}
          </button>
          <div className="max-h-[50dvh] overflow-y-auto rounded border border-border p-1">
            <TreeView
              roots={activeTree.roots}
              label={t('locations.move.treeLabel')}
              expanded={expanded}
              onExpandedChange={setExpanded}
              visibleIds={search?.visible}
              selectedId={target ?? null}
              onSelect={pick}
              disabled={tn => blocked.has(tn.id)}
              rowTestId={tn => `location-move-node-${tn.node.code}`}
              renderRow={tn => (
                <span className={cn('flex min-w-0 flex-1 items-center gap-2', blocked.has(tn.id) && 'text-fg-subtle')}>
                  <span className="truncate">{tn.node.name}</span>
                  <span className="text-xs text-fg-subtle">{tn.node.levelLabel}</span>
                  {tn.id === node.id && <span className="text-xs text-fg-subtle">{t('locations.move.self')}</span>}
                  {tn.id === node.parentId && <span className="text-xs text-fg-subtle">{t('locations.move.current')}</span>}
                </span>
              )}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Formats `meta.usedBy` from a 409 delete (shape not pinned by the contract: array of rows or a record of counts). */
export function formatUsedBy(usedBy: unknown): string[] {
  if (Array.isArray(usedBy)) {
    return usedBy.map(u => {
      if (typeof u === 'string') return u;
      const o = u as Record<string, unknown>;
      const name = String(o.label ?? o.name ?? o.kind ?? o.type ?? '');
      const count = o.count ?? o.total;
      return count !== undefined ? `${name} (${String(count)})` : name;
    }).filter(Boolean);
  }
  if (usedBy && typeof usedBy === 'object') return Object.entries(usedBy as Record<string, unknown>).map(([k, v]) => `${k} (${String(v)})`);
  return [];
}
