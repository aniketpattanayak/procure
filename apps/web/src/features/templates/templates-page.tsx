'use client';
import {
  Badge, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, EmptyState, NativeSelect, Segmented,
  Skeleton, SkeletonGroup, StatusBadge, toast,
} from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileCode2, MoreHorizontal, Plus, Star, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageBody, PageHeader } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtRelative } from '@/lib/format';
import { usePermissions } from '@/lib/permissions';
import { useSession } from '@/lib/session';
import { useDocTypes } from '@/features/documents/api';
import { notifyKeys, templatesApi, type TemplateChannel, type TemplateRow } from '@/features/notify/api';
import { ChannelTag, channelIcon, channelLabel } from '@/features/notify/ui';

const CHANNELS: TemplateChannel[] = ['pdf', 'email', 'whatsapp', 'inapp'];

/** Channels the plan allows: email / WhatsApp need their plan features; PDF and in-app are always there. */
export function useAllowedChannels(): TemplateChannel[] {
  const { features } = useSession();
  return CHANNELS.filter(c => (c === 'email' ? features.has('email') : c === 'whatsapp' ? features.has('whatsapp') : true));
}

/** /config/templates: every template by channel and document type. */
export function TemplatesPage() {
  const p = usePermissions();
  const router = useRouter();
  const sp = useSearchParams();
  const qc = useQueryClient();
  const canEdit = p.has('config.templates:action.edit');
  const allowed = useAllowedChannels();
  const [channel, setChannel] = useState<'all' | TemplateChannel>((sp.get('channel') as TemplateChannel) ?? 'all');
  const [docType, setDocType] = useState(sp.get('docType') ?? '');
  const [removing, setRemoving] = useState<TemplateRow | null>(null);
  const docTypes = useDocTypes();
  const typeName = useMemo(() => new Map((docTypes.data ?? []).map(d => [d.key, d.name])), [docTypes.data]);
  const list = useQuery({ queryKey: notifyKeys.templatesAll, queryFn: () => templatesApi.list() });

  const rows = (list.data ?? [])
    .filter(r => (channel === 'all' || r.channel === channel) && (!docType || (docType === '_any' ? r.docTypeKey === null : r.docTypeKey === docType)))
    .sort((a, b) => (a.docTypeKey ?? '').localeCompare(b.docTypeKey ?? '') || CHANNELS.indexOf(a.channel) - CHANNELS.indexOf(b.channel) || Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));

  // Group rows by document type so "which PO layouts do we have" reads at a glance.
  const groups = useMemo(() => {
    const m = new Map<string, TemplateRow[]>();
    for (const r of rows) { const k = r.docTypeKey ?? ''; m.set(k, [...(m.get(k) ?? []), r]); }
    return [...m.entries()];
  }, [rows]);

  const newHref = (c: TemplateChannel) => `/config/templates/new?channel=${c}${docType && docType !== '_any' ? `&docType=${docType}` : ''}`;

  return (
    <PageBody>
      <PageHeader
        title={t('tpl.title')}
        description={t('tpl.description')}
        actions={canEdit && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button data-testid="tpl-new"><Plus aria-hidden />{t('tpl.new')}</Button></DropdownMenuTrigger>
            <DropdownMenuContent>
              {allowed.map(c => {
                const Icon = channelIcon[c];
                return <DropdownMenuItem key={c} onSelect={() => router.push(newHref(c))} data-testid={`tpl-new-${c}`}><Icon className="size-4" aria-hidden />{t(`tpl.new.${c}`)}</DropdownMenuItem>;
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          label={t('tpl.filter.channel')}
          value={channel}
          onChange={setChannel}
          data-testid="tpl-filter-channel"
          options={[{ value: 'all', label: t('tpl.filter.all') }, ...CHANNELS.map(c => ({ value: c, label: channelLabel(c) }))]}
        />
        <NativeSelect aria-label={t('tpl.filter.docType')} value={docType} onChange={e => setDocType(e.target.value)} className="h-8 w-auto min-w-[12rem] text-sm" data-testid="tpl-filter-doctype">
          <option value="">{t('tpl.filter.allDocTypes')}</option>
          <option value="_any">{t('tpl.anyDocument')}</option>
          {(docTypes.data ?? []).map(d => <option key={d.key} value={d.key}>{d.name}</option>)}
        </NativeSelect>
      </div>

      {list.isLoading ? (
        <SkeletonGroup className="space-y-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-12" />)}</SkeletonGroup>
      ) : list.error ? (
        <EmptyState title={isApiError(list.error) ? list.error.message : t('table.error')} action={<Button variant="secondary" onClick={() => void list.refetch()}>{t('common.retry')}</Button>} />
      ) : !rows.length ? (
        <EmptyState icon={<FileCode2 />} title={t('tpl.empty')} description={t('tpl.emptyHint')}
          action={canEdit ? <Button asChild><Link href={newHref(channel === 'all' ? 'pdf' : channel)}>{t('tpl.new')}</Link></Button> : undefined} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface" data-testid="tpl-list">
          <table className="w-full">
            <thead className="bg-subtle text-left text-sm text-fg-muted">
              <tr>
                <th className="px-4 py-2 font-medium">{t('tpl.col.name')}</th>
                <th className="px-4 py-2 font-medium">{t('tpl.col.channel')}</th>
                <th className="hidden px-4 py-2 font-medium md:table-cell">{t('tpl.col.status')}</th>
                <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">{t('tpl.col.updated')}</th>
                <th className="w-12 px-2 py-2"><span className="sr-only">{t('common.actions')}</span></th>
              </tr>
            </thead>
            {groups.map(([key, items]) => (
              <tbody key={key || '_any'} data-testid={`tpl-group-${key || 'any'}`}>
                <tr className="border-t border-border bg-subtle/60">
                  <th colSpan={5} scope="colgroup" className="px-4 py-1.5 text-left text-sm font-semibold">
                    {key ? typeName.get(key) ?? key : t('tpl.anyDocument')}
                    <span className="ml-2 font-normal text-fg-subtle">{t('tpl.countN', { n: items.length })}</span>
                  </th>
                </tr>
                {items.map(r => (
                  <tr key={r.id} className="border-t border-border hover:bg-subtle/50" data-testid={`tpl-row-${r.key}`} data-channel={r.channel}>
                    <td className="px-4 py-2.5">
                      <Link href={`/config/templates/${r.id}`} className="font-medium hover:text-accent hover:underline" data-testid={`tpl-open-${r.key}`}>{r.name}</Link>
                      <code className="ml-2 hidden text-xs text-fg-subtle sm:inline">{r.key}</code>
                    </td>
                    <td className="px-4 py-2.5"><ChannelTag channel={r.channel} /></td>
                    <td className="hidden px-4 py-2.5 md:table-cell">
                      <span className="flex flex-wrap items-center gap-1.5">
                        {r.isDefault && <Badge tone="accent" data-testid={`tpl-default-${r.key}`}><Star className="size-3" aria-hidden />{t('tpl.default')}</Badge>}
                        {!r.isActive && <StatusBadge>{t('tpl.inactive')}</StatusBadge>}
                        <span className="text-xs tabular-nums text-fg-subtle">v{r.version}</span>
                      </span>
                    </td>
                    <td className="hidden px-4 py-2.5 text-right text-sm text-fg-muted sm:table-cell" title={r.updatedAt}>{fmtRelative(r.updatedAt)}</td>
                    <td className="px-2 py-2 text-right">
                      {canEdit && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={t('tpl.menu', { name: r.name })} data-testid={`tpl-menu-${r.key}`}><MoreHorizontal aria-hidden /></Button></DropdownMenuTrigger>
                          <DropdownMenuContent>
                            <DropdownMenuItem onSelect={() => router.push(`/config/templates/new?copy=${r.id}`)} data-testid="tpl-duplicate"><Plus className="size-4" aria-hidden />{t('tpl.duplicate')}</DropdownMenuItem>
                            <DropdownMenuItem destructive onSelect={() => setRemoving(r)} data-testid="tpl-delete"><Trash2 className="size-4" aria-hidden />{t('tpl.delete')}</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}

      <ConfirmDialog open={!!removing} onOpenChange={o => !o && setRemoving(null)} testId="tpl-delete-dialog" tone="danger"
        title={t('tpl.deleteTitle', { name: removing?.name ?? '' })} description={t('tpl.deleteHint')} confirmLabel={t('tpl.delete')}
        onConfirm={async () => {
          await templatesApi.remove(removing!.id);
          toast.success(t('tpl.deleted'));
          void qc.invalidateQueries({ queryKey: notifyKeys.templatesAll });
        }} />
    </PageBody>
  );
}
