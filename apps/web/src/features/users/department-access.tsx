'use client';
import { Button, Card, CardBody, Checkbox, Skeleton, Switch, toast } from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { InlineAlert } from '@/components/page';
import { mastersApi } from '@/features/masters/api';
import { t } from '@/i18n';
import { http, isApiError } from '@/lib/api';

interface UserDepartments { all: boolean; departmentIds: string[] }
const deptApi = {
  get: (userId: string) => http.get<UserDepartments>(`/users/${userId}/departments`),
  put: (userId: string, body: UserDepartments) => http.put<UserDepartments>(`/users/${userId}/departments`, body),
};

/**
 * Department-wise access for one user: "All departments" or a chosen list. A limited user sees indents of their
 * departments (plus indents they created); indents without a department only for "All departments".
 */
export function DepartmentAccess({ userId, isTenantAdmin }: { userId: string; isTenantAdmin: boolean }) {
  const qc = useQueryClient();
  const current = useQuery({ queryKey: ['users', userId, 'departments'], queryFn: () => deptApi.get(userId) });
  const depts = useQuery({ queryKey: ['masters', 'department', 'all-active'], queryFn: () => mastersApi.records('department', { view: 'active', limit: 200, sort: 'name' }) });
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!current.data) return;
    setAll(current.data.all);
    setPicked(new Set(current.data.departmentIds));
  }, [current.data]);
  const initial = current.data ? `${current.data.all}|${[...current.data.departmentIds].sort().join(',')}` : '';
  const now = `${all}|${[...picked].sort().join(',')}`;
  const dirty = !!current.data && initial !== now;
  const rows = useMemo(() => depts.data?.data ?? [], [depts.data]);

  async function save() {
    setSaving(true); setError(null);
    try {
      const next = await deptApi.put(userId, { all, departmentIds: all ? [] : [...picked] });
      qc.setQueryData(['users', userId, 'departments'], next);
      toast.success(t('access.dept.saved'));
    } catch (e) {
      setError(isApiError(e) ? e.message : String(e));
    } finally { setSaving(false); }
  }

  if (current.isLoading || depts.isLoading) return <Skeleton className="h-48 w-full" />;
  if (current.isError) return <InlineAlert>{(current.error as Error).message}</InlineAlert>;
  return (
    <Card data-testid="dept-access">
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">{t('access.dept.title')}</h2>
            <p className="text-sm text-fg-muted">{t('access.dept.hint')}</p>
          </div>
          <Button onClick={() => void save()} loading={saving} disabled={!dirty || saving || (!all && picked.size === 0)} data-testid="dept-save">{t('access.dept.save')}</Button>
        </div>
        {isTenantAdmin && <InlineAlert tone="info">{t('access.dept.admin')}</InlineAlert>}
        <label className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
          <Switch checked={all} onCheckedChange={v => setAll(!!v)} data-testid="dept-all" />
          <span>
            <span className="block font-medium">{t('access.dept.all')}</span>
            <span className="block text-sm text-fg-muted">{t('access.dept.allHint')}</span>
          </span>
        </label>
        {!all && (
          <div className="space-y-2">
            {rows.length === 0 ? <p className="text-sm text-fg-muted">{t('access.dept.none')}</p> : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {rows.map(r => (
                  <li key={r.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2">
                      <Checkbox checked={picked.has(r.id)} onCheckedChange={v => setPicked(s => { const n = new Set(s); if (v) n.add(r.id); else n.delete(r.id); return n; })} data-testid={`dept-pick-${r.code}`} />
                      <span>{r.name} <span className="text-sm text-fg-subtle">{r.code}</span></span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {picked.size === 0 && <p className="text-sm text-danger">{t('access.dept.pickOne')}</p>}
            <p className="text-sm text-fg-muted">{t('access.dept.rule')}</p>
          </div>
        )}
        {error && <InlineAlert>{error}</InlineAlert>}
      </CardBody>
    </Card>
  );
}
