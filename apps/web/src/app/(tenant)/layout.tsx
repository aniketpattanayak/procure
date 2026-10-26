'use client';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useMemo } from 'react';
import { AreaGuard } from '@/components/area-guard';
import { AppShell } from '@/components/shell/app-shell';
import { docTypeIcon, masterIcon, procurementDocTypes, procurementNav, sectionOrder, storeDocTypes, storesNav, tenantNav, type NavItem } from '@/components/shell/nav';
import { NotificationsBell } from '@/components/shell/notifications';
import { docTab, useDocTypes } from '@/features/documents/api';
import { setDocExtensionGate } from '@/features/documents/extensions';
import { mastersNavApi, qk } from '@/features/permissions/api';
import { setLabelOverrides, type MessageKey } from '@/i18n';
import { perm, useMe, usePermissions } from '@/lib/permissions';
import { useSession } from '@/lib/session';

function TenantShell({ children }: { children: ReactNode }) {
  const { principal, features } = useSession();
  const me = useMe();
  const p = usePermissions();

  // Tenant wording overrides win over en.json. Applied during render so children see them on this pass.
  const labels = me?.labels;
  useMemo(() => setLabelOverrides((labels ?? {}) as Partial<Record<MessageKey, string>>), [labels]);
  useEffect(() => () => setLabelOverrides({}), []);
  // Permission/feature source for component-style document extensions (`visible` checks on tabs).
  useMemo(() => setDocExtensionGate({ has: p.has, features }), [p, features]);

  const masters = useQuery({ queryKey: qk.masters, queryFn: mastersNavApi.list, enabled: p.ready, staleTime: 5 * 60_000, retry: false });
  const docTypes = useDocTypes();

  // Hidden, not disabled: entries outside the plan or without the view key never render.
  const nav = useMemo(() => {
    const settings = (me?.settings ?? {}) as Record<string, unknown>;
    const settingOn = (keys?: string | string[]) => !keys || (Array.isArray(keys) ? keys : [keys]).every(k => settings[k] !== false);
    const fixed = [...tenantNav, ...procurementNav, ...storesNav].filter(i => (!i.feature || features.has(i.feature)) && (!i.perm || p.has(i.perm)) && settingOn(i.setting));
    const masterItems: NavItem[] = (masters.data ?? [])
      .filter(m => m.isActive && p.has(perm.action(perm.masterTab(m.key), 'view')))
      .sort((a, b) => a.pluralName.localeCompare(b.pluralName))
      .map(m => ({ href: `/masters/${m.key}`, label: 'nav.section.masters', text: m.pluralName || m.name, icon: masterIcon, section: 'masters' }));
    // Modules: document types the user can view (`doc.<key>:action.view`), shown when active and `showInMenu`.
    const docItems: NavItem[] = (docTypes.data ?? [])
      .filter(d => d.isActive && d.settings.showInMenu !== false && p.has(perm.action(docTab(d.key), 'view')))
      .filter(d => settingOn(procurementDocTypes[d.key]?.setting))
      .map(d => {
        const proc = procurementDocTypes[d.key];
        const store = storeDocTypes[d.key];
        return { href: `/docs/${d.key}`, label: 'nav.section.modules', text: d.pluralName || d.name, icon: docTypeIcon, section: proc ? 'procurement' : store ? 'stores' : 'modules', order: proc?.order ?? store?.order } satisfies NavItem;
      });
    const all = [...fixed, ...docItems, ...masterItems];
    const order: string[] = sectionOrder;
    const pos = (x: NavItem, i: number) => x.order ?? 1000 + i;
    return all.map((item, i) => ({ item, i })).sort((a, b) => order.indexOf(a.item.section ?? 'main') - order.indexOf(b.item.section ?? 'main') || pos(a.item, a.i) - pos(b.item, b.i)).map(x => x.item);
  }, [features, p, masters.data, docTypes.data, me?.settings]);

  return (
    <AppShell nav={nav} subtitle={principal?.kind === 'tenant' ? principal.tenantName : undefined} showLocation actions={<NotificationsBell />}>
      {children}
    </AppShell>
  );
}

export default function TenantLayout({ children }: { children: ReactNode }) {
  return (
    <AreaGuard kind="tenant">
      <TenantShell>{children}</TenantShell>
    </AreaGuard>
  );
}
