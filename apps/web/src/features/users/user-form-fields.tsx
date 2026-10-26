'use client';
import { Checkbox, FormField, Input, Label, Skeleton, Switch } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { Controller, type Control, type FieldErrors, type UseFormRegister } from 'react-hook-form';
import { t } from '@/i18n';
import { rolesApi } from './api';

export interface UserFormShape {
  name?: string;
  email?: string;
  phone?: string;
  isTenantAdmin?: boolean;
  roleIds?: string[];
}

/** Fields shared by create and edit. Email is only editable on create (contract: UserUpdate omits email). */
export function UserFormFields({ register, control, errors, includeEmail }: {
  register: UseFormRegister<UserFormShape>;
  control: Control<UserFormShape>;
  errors: FieldErrors<UserFormShape>;
  includeEmail: boolean;
}) {
  const roles = useQuery({ queryKey: ['roles'], queryFn: rolesApi.list, staleTime: 5 * 60_000 });
  return (
    <div className="space-y-4">
      <FormField label={t('users.field.name')} error={errors.name?.message} required>
        <Input autoComplete="off" {...register('name')} data-testid="user-name" />
      </FormField>
      {includeEmail && (
        <FormField label={t('users.field.email')} error={errors.email?.message} required>
          <Input type="email" autoComplete="off" {...register('email')} data-testid="user-email" />
        </FormField>
      )}
      <FormField label={t('users.field.phone')} error={errors.phone?.message} hint={t('common.optional')}>
        <Input type="tel" autoComplete="off" {...register('phone')} data-testid="user-phone" />
      </FormField>
      <Controller
        control={control}
        name="isTenantAdmin"
        render={({ field }) => (
          <div className="flex items-start justify-between gap-4 rounded border border-border p-3">
            <div>
              <Label htmlFor="user-admin">{t('users.field.admin')}</Label>
              <p className="text-sm text-fg-muted">{t('users.field.adminHint')}</p>
            </div>
            <Switch id="user-admin" checked={!!field.value} onCheckedChange={field.onChange} data-testid="user-admin" />
          </div>
        )}
      />
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">{t('users.field.roles')}</legend>
        {roles.isLoading ? (
          <div className="space-y-2"><Skeleton className="h-5 w-40" /><Skeleton className="h-5 w-32" /></div>
        ) : !roles.data?.length ? (
          <p className="text-sm text-fg-muted">{t('users.noRoles')}</p>
        ) : (
          <Controller
            control={control}
            name="roleIds"
            render={({ field }) => {
              const value = field.value ?? [];
              return (
                <ul className="grid gap-2 sm:grid-cols-2">
                  {roles.data.map(r => (
                    <li key={r.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`role-${r.id}`}
                        checked={value.includes(r.id)}
                        onCheckedChange={c => field.onChange(c ? [...value, r.id] : value.filter(v => v !== r.id))}
                      />
                      <Label htmlFor={`role-${r.id}`} className="font-normal">{r.name}</Label>
                    </li>
                  ))}
                </ul>
              );
            }}
          />
        )}
        {errors.roleIds?.message && <p role="alert" className="mt-1 text-xs font-medium text-danger">{errors.roleIds.message}</p>}
      </fieldset>
    </div>
  );
}

export function cleanOptional<T extends Record<string, unknown>>(v: T): T {
  const out = { ...v };
  for (const k of Object.keys(out)) if (out[k] === '') delete out[k];
  return out;
}
