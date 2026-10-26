'use client';
import { Button, Card, CardBody, CardHeader, Input } from '@procure/ui';
import { ArrowDown, ArrowUp, Plus, RotateCcw, X } from 'lucide-react';
import { t } from '@/i18n';

/** Ordered list of location level names (`labels.location_levels`). Depth n uses item n; deeper levels reuse the last. */
export function LevelsEditor({ value, defaultValue, onChange, disabled, error }: {
  value: string[];
  defaultValue: string[];
  onChange: (v: string[]) => void;
  disabled: boolean;
  error?: string;
}) {
  const move = (i: number, d: -1 | 1) => {
    const next = [...value];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    onChange(next);
  };
  const isDefault = JSON.stringify(value) === JSON.stringify(defaultValue);
  return (
    <Card data-testid="levels-editor">
      <CardHeader
        title={t('settings.levels.title')}
        description={t('settings.levels.hint')}
        actions={!isDefault && !disabled && <Button size="sm" variant="ghost" onClick={() => onChange(defaultValue)} data-testid="levels-reset"><RotateCcw aria-hidden />{t('settings.reset')}</Button>}
      />
      <CardBody className="space-y-3">
        {error && <p className="text-sm font-medium text-danger" role="alert">{error}</p>}
        <ol className="space-y-2" aria-label={t('settings.levels.title')}>
          {value.map((name, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-sm text-fg-muted">{t('settings.levels.depth', { n: i + 1 })}</span>
              <Input
                value={name}
                onChange={e => onChange(value.map((v, j) => (j === i ? e.target.value : v)))}
                disabled={disabled}
                maxLength={40}
                aria-label={t('settings.levels.nameFor', { n: i + 1 })}
                aria-invalid={!name.trim() || undefined}
                data-testid={`level-${i}`}
              />
              <Button variant="ghost" size="icon-sm" onClick={() => move(i, -1)} disabled={disabled || i === 0} aria-label={t('settings.levels.up', { name })}><ArrowUp aria-hidden /></Button>
              <Button variant="ghost" size="icon-sm" onClick={() => move(i, 1)} disabled={disabled || i === value.length - 1} aria-label={t('settings.levels.down', { name })}><ArrowDown aria-hidden /></Button>
              <Button variant="ghost" size="icon-sm" onClick={() => onChange(value.filter((_, j) => j !== i))} disabled={disabled || value.length <= 1} aria-label={t('settings.levels.remove', { name })} data-testid={`level-${i}-remove`}><X aria-hidden /></Button>
            </li>
          ))}
        </ol>
        {!disabled && <Button size="sm" variant="secondary" onClick={() => onChange([...value, ''])} disabled={value.length >= 10} data-testid="level-add"><Plus aria-hidden />{t('settings.levels.add')}</Button>}
        {value.length > 0 && (
          <p className="text-sm text-fg-muted" data-testid="levels-preview">
            {t('settings.levels.preview', { chain: value.filter(Boolean).join(' › '), last: value.filter(Boolean).at(-1) ?? '' })}
          </p>
        )}
      </CardBody>
    </Card>
  );
}
