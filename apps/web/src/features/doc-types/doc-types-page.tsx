'use client';
import type { DocTypeSummary } from '@procure/schema';
import {
  Badge, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState,
  Skeleton, SkeletonGroup, StatusBadge, toast,
} from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileStack, Hash, MoreHorizontal, PencilRuler, Plus, Power, Settings2, Workflow } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageBody, PageHeader } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { useMe, usePermissions } from '@/lib/permissions';
import { docTypesApi } from './api';
import { DocTypeIcon } from './icons';
import { CreateDocTypeWizard } from './create-wizard';
import { DocTypeSettingsDialog } from './settings-dialog';

export function useCustomFormsLimit() {
  const me = useMe();
  const l = me?.limits?.find(x => x.key === 'custom_forms');
  if (!l || l.effective === null) return null;
  return { used: l.used, max: l.effective, full: l.used >= l.effective };
}

/** /config/doc-types: document types (system + custom) with links to their forms, workflow and numbering. */
export function DocTypesPage() {
  const p = usePermissions();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['doc-types'], queryFn: docTypesApi.list });
  const [wizard, setWizard] = useState(false);
  const [editing, setEditing] = useState<DocTypeSummary | null>(null);
  const [toggling, setToggling] = useState<DocTypeSummary | null>(null);
  const limit = useCustomFormsLimit();
  const canAdd = p.has('config.doc_types:action.add');
  const canEdit = p.has('config.doc_types:action.edit');

  // /config/doc-types?new=1 opens the wizard (link from the empty workflows page).
  useEffect(() => {
    try { if (new URLSearchParams(window.location.search).get('new') === '1' && canAdd) setWizard(true); } catch { /* ignore */ }
  }, [canAdd]);

  async function toggle(d: DocTypeSummary) {
    try {
      if (d.isActive) await docTypesApi.deactivate(d.key);
      else await docTypesApi.activate(d.key);
      void qc.invalidateQueries({ queryKey: ['doc-types'] });
      toast.success(d.isActive ? t('dt.deactivated', { name: d.name }) : t('dt.activated', { name: d.name }));
    } catch (e) {
      throw new Error(isApiError(e) ? e.message : String(e));
    }
  }

  const rows = [...(list.data ?? [])].sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return (
    <PageBody>
      <PageHeader
        title={t('dt.title')}
        description={t('dt.description')}
        actions={canAdd && (
          <Button onClick={() => setWizard(true)} disabled={!!limit?.full} title={limit?.full ? t('dt.limitReached', { n: limit.max }) : undefined} data-testid="doctype-new">
            <Plus aria-hidden />{t('dt.new')}
          </Button>
        )}
      />
      {limit && (
        <p className={limit.full ? 'mb-3 text-sm text-warning' : 'mb-3 text-sm text-fg-muted'} data-testid="doctype-limit" data-full={limit.full || undefined}>
          {limit.full ? t('dt.limitReached', { n: limit.max }) : t('dt.limitUsage', { used: limit.used, n: limit.max })}
        </p>
      )}
      {list.isLoading ? (
        <SkeletonGroup className="space-y-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-16" />)}</SkeletonGroup>
      ) : list.error ? (
        <EmptyState title={t('table.error')} description={isApiError(list.error) ? list.error.message : undefined} action={<Button variant="secondary" onClick={() => void list.refetch()}>{t('common.retry')}</Button>} />
      ) : !rows.length ? (
        <EmptyState icon={<FileStack />} title={t('dt.empty')} description={t('dt.emptyHint')}
          action={canAdd ? <Button onClick={() => setWizard(true)}>{t('dt.new')}</Button> : undefined} />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface" data-testid="doctype-list">
          {rows.map(d => (
            <li key={d.key} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center" data-testid={`doctype-row-${d.key}`} data-active={d.isActive}>
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent" aria-hidden>
                  <DocTypeIcon name={d.settings.icon} className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{d.pluralName}</span>
                    <code className="text-xs text-fg-subtle">{d.key}</code>
                    {d.kind === 'system' && <Badge>{t('dt.system')}</Badge>}
                    {d.isActive ? <StatusBadge tone="success">{t('dt.active')}</StatusBadge> : <StatusBadge>{t('dt.inactive')}</StatusBadge>}
                  </p>
                  <p className="text-sm text-fg-muted">
                    {d.lineFormKey ? t('dt.shape.lines') : t('dt.shape.header')}
                    {d.description ? `. ${d.description}` : ''}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1 sm:justify-end">
                {p.has('config.forms:action.view') && (
                  <Button asChild size="sm" variant="ghost"><Link href={`/config/forms/${d.headerFormKey}`} data-testid={`doctype-header-form-${d.key}`}><PencilRuler aria-hidden />{t('dt.headerForm')}</Link></Button>
                )}
                {p.has('config.forms:action.view') && d.lineFormKey && (
                  <Button asChild size="sm" variant="ghost"><Link href={`/config/forms/${d.lineFormKey}`} data-testid={`doctype-line-form-${d.key}`}><PencilRuler aria-hidden />{t('dt.lineForm')}</Link></Button>
                )}
                {p.has('config.workflows:action.view') && (
                  <Button asChild size="sm" variant="ghost"><Link href={`/config/workflows/${d.key}`} data-testid={`doctype-workflow-${d.key}`}><Workflow aria-hidden />{t('dt.workflow')}</Link></Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon-sm" variant="ghost" aria-label={t('dt.moreFor', { name: d.name })} data-testid={`doctype-menu-${d.key}`}><MoreHorizontal aria-hidden /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    {p.has('config.numbering:action.view') && (
                      <DropdownMenuItem asChild><Link href={`/config/numbering?docType=${d.key}`} data-testid={`doctype-numbering-${d.key}`}><Hash aria-hidden />{t('dt.numbering')}</Link></DropdownMenuItem>
                    )}
                    {canEdit && <DropdownMenuItem onSelect={() => setEditing(d)} data-testid={`doctype-settings-${d.key}`}><Settings2 aria-hidden />{t('dt.settings')}</DropdownMenuItem>}
                    {canEdit && d.kind === 'custom' && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem destructive={d.isActive} onSelect={() => setToggling(d)} data-testid={`doctype-toggle-${d.key}`}><Power aria-hidden />{d.isActive ? t('dt.deactivate') : t('dt.activate')}</DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </li>
          ))}
        </ul>
      )}
      {wizard && <CreateDocTypeWizard onClose={() => setWizard(false)} limitFull={!!limit?.full} />}
      {editing && <DocTypeSettingsDialog docType={editing} onClose={() => setEditing(null)} />}
      {toggling && (
        <ConfirmDialog open onOpenChange={o => { if (!o) setToggling(null); }}
          title={toggling.isActive ? t('dt.confirmDeactivate', { name: toggling.name }) : t('dt.confirmActivate', { name: toggling.name })}
          description={toggling.isActive ? t('dt.confirmDeactivateBody') : undefined}
          confirmLabel={toggling.isActive ? t('dt.deactivate') : t('dt.activate')} tone={toggling.isActive ? 'danger' : 'primary'}
          onConfirm={() => toggle(toggling)} testId="doctype-confirm-toggle" />
      )}
    </PageBody>
  );
}
