'use client';
import type { MasterSummary } from '@procure/schema';
import { Badge, Button, EmptyState, Skeleton, SkeletonGroup, StatusBadge, toast } from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Lock, PencilRuler, Plus, Settings2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageBody, PageHeader } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtNumber } from '@/lib/format';
import { useMe, usePermissions } from '@/lib/permissions';
import { mastersApi } from './api';

const NewMasterWizard = dynamic(() => import('./new-master-wizard').then(m => m.NewMasterWizard), { ssr: false });
const MasterSettingsDialog = dynamic(() => import('./master-settings-dialog').then(m => m.MasterSettingsDialog), { ssr: false });

export function MastersConfigPage() {
  const p = usePermissions();
  const me = useMe();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['masters'], queryFn: mastersApi.list, staleTime: 30_000 });
  const [wizard, setWizard] = useState(false);
  const [editing, setEditing] = useState<MasterSummary | null>(null);
  const [toggling, setToggling] = useState<MasterSummary | null>(null);

  if (p.ready && !p.has('config.masters:action.view')) {
    return <PageBody><EmptyState icon={<Lock />} title={t('masters.noAccess')} description={t('masters.noAccessHint')} /></PageBody>;
  }

  const limit = me?.limits?.find(l => l.key === 'custom_forms');
  const custom = (list.data ?? []).filter(m => !m.isSystem).length;
  const atLimit = !!limit && limit.effective !== null && custom >= limit.effective;
  const canAdd = p.has('config.masters:action.add');
  const canEdit = p.has('config.masters:action.edit');

  async function toggle(m: MasterSummary) {
    try {
      if (m.isActive) await mastersApi.deactivateMaster(m.key);
      else await mastersApi.activateMaster(m.key);
      void qc.invalidateQueries({ queryKey: ['masters'] });
      toast.success(m.isActive ? t('masters.masterDeactivated', { name: m.name }) : t('masters.masterActivated', { name: m.name }));
    } catch (e) {
      throw new Error(isApiError(e) ? e.message : String(e));
    }
  }

  const sorted = [...(list.data ?? [])].sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.name.localeCompare(b.name));

  return (
    <PageBody>
      <PageHeader
        title={t('masters.configTitle')}
        description={t('masters.configDescription')}
        actions={canAdd && (
          <Button onClick={() => setWizard(true)} data-testid="new-master-button" disabled={atLimit} title={atLimit ? t('masters.limitReached', { n: limit!.effective! }) : undefined}>
            <Plus aria-hidden />{t('masters.newMaster')}
          </Button>
        )}
      />
      {limit && limit.effective !== null && (
        <p className={atLimit ? 'mb-3 text-sm text-warning' : 'mb-3 text-sm text-fg-muted'} data-testid="custom-forms-usage">
          {atLimit ? t('masters.limitReached', { n: limit.effective }) : t('masters.limitUsage', { used: custom, n: limit.effective })}
        </p>
      )}
      {list.isLoading ? (
        <SkeletonGroup className="space-y-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-14" />)}</SkeletonGroup>
      ) : list.error ? (
        <EmptyState title={t('table.error')} action={<Button variant="secondary" onClick={() => void list.refetch()}>{t('common.retry')}</Button>} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <table className="w-full text-base" data-testid="masters-table">
            <thead className="bg-subtle text-left text-sm text-fg-muted">
              <tr>
                <th className="px-4 py-2 font-medium">{t('masters.colName')}</th>
                <th className="hidden px-4 py-2 font-medium md:table-cell">{t('masters.colKey')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('masters.colRecords')}</th>
                <th className="hidden px-4 py-2 font-medium sm:table-cell">{t('masters.status')}</th>
                <th className="px-4 py-2"><span className="sr-only">{t('common.actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(m => (
                <tr key={m.key} className="border-t border-border" data-testid={`master-row-${m.key}`}>
                  <td className="px-4 py-2.5">
                    <Link href={`/masters/${m.key}`} className="font-medium hover:text-accent hover:underline">{m.pluralName}</Link>
                    {m.isSystem && <Badge className="ml-2">{t('masters.system')}</Badge>}
                    {m.description && <p className="max-w-md truncate text-sm text-fg-muted">{m.description}</p>}
                  </td>
                  <td className="hidden px-4 py-2.5 md:table-cell"><code className="text-sm text-fg-muted">{m.key}</code></td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{fmtNumber(m.recordCount)}</td>
                  <td className="hidden px-4 py-2.5 sm:table-cell">{m.isActive ? <StatusBadge tone="success">{t('masters.active')}</StatusBadge> : <StatusBadge tone="neutral">{t('masters.inactive')}</StatusBadge>}</td>
                  <td className="px-2 py-2.5">
                    <div className="flex justify-end gap-1">
                      {p.has('config.forms:action.view') && (
                        <Button asChild size="sm" variant="ghost"><Link href={`/config/forms/${m.formKey}`} data-testid={`master-form-${m.key}`}><PencilRuler aria-hidden /><span className="hidden lg:inline">{t('masters.editForm')}</span></Link></Button>
                      )}
                      {canEdit && <Button size="sm" variant="ghost" onClick={() => setEditing(m)} aria-label={t('masters.settingsFor', { name: m.name })} data-testid={`master-settings-${m.key}`}><Settings2 aria-hidden /></Button>}
                      {canEdit && !m.isSystem && (
                        <Button size="sm" variant="ghost" onClick={() => setToggling(m)} data-testid={`master-toggle-${m.key}`}>{m.isActive ? t('masters.deactivate') : t('masters.activate')}</Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr><td colSpan={5}><EmptyState icon={<Database />} title={t('masters.noneYet')} /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {wizard && <NewMasterWizard onClose={() => setWizard(false)} />}
      {editing && <MasterSettingsDialog master={editing} onClose={() => setEditing(null)} />}
      {toggling && (
        <ConfirmDialog open onOpenChange={o => { if (!o) setToggling(null); }}
          title={toggling.isActive ? t('masters.confirmMasterDeactivate', { name: toggling.name }) : t('masters.confirmMasterActivate', { name: toggling.name })}
          description={toggling.isActive ? t('masters.confirmMasterDeactivateBody') : undefined}
          confirmLabel={toggling.isActive ? t('masters.deactivate') : t('masters.activate')} tone={toggling.isActive ? 'danger' : 'primary'}
          onConfirm={() => toggle(toggling)} testId="confirm-master-toggle" />
      )}
    </PageBody>
  );
}
