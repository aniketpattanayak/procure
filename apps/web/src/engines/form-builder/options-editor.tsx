'use client';
import { Button, cn, Input, NativeSelect } from '@procure/ui';
import { ArrowDown, ArrowUp, ClipboardPaste, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { t } from '@/i18n';
import { keyFromLabel } from './catalog';

type Opt = { value: string; label: string; color?: 'neutral' | 'blue' | 'green' | 'amber' | 'red'; inactive?: boolean };

/**
 * Options for select / multiselect / radio. Values of published options are locked (records store the value);
 * retire them with "inactive" instead of deleting.
 */
export function OptionsEditor({ options, onChange, lockedValues }: { options: Opt[]; onChange: (o: Opt[]) => void; lockedValues: Set<string> }) {
  const [bulk, setBulk] = useState<string | null>(null);
  const opts = options as Opt[];
  const dupes = new Set(opts.map(o => o.value).filter((v, i, a) => a.indexOf(v) !== i));

  const set = (i: number, patch: Partial<Opt>) => onChange(opts.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const move = (i: number, d: -1 | 1) => {
    const n = [...opts];
    const [x] = n.splice(i, 1);
    n.splice(i + d, 0, x!);
    onChange(n);
  };
  const add = () => {
    const taken = new Set(opts.map(o => o.value));
    let n = opts.length + 1;
    while (taken.has(`option_${n}`)) n++;
    onChange([...opts, { value: `option_${n}`, label: `Option ${n}` }]);
  };

  function applyBulk() {
    const lines = (bulk ?? '').split('\n').map(l => l.trim()).filter(Boolean);
    const taken = new Set(opts.map(o => o.value));
    const added: Opt[] = [];
    for (const l of lines) {
      const [label, value] = l.includes('|') ? l.split('|').map(s => s.trim()) as [string, string] : [l, keyFromLabel(l)];
      if (!label || taken.has(value)) continue;
      taken.add(value);
      added.push({ value: value.slice(0, 100), label: label.slice(0, 200) });
    }
    onChange([...opts, ...added]);
    setBulk(null);
  }

  return (
    <div className="space-y-2" data-testid="prop-options">
      <ul className="space-y-1.5">
        {opts.map((o, i) => {
          const locked = lockedValues.has(o.value);
          return (
            <li key={i} className={cn('rounded border border-border p-1.5', o.inactive && 'bg-subtle')}>
              <div className="flex items-center gap-1">
                <Input className="h-7 flex-1 text-sm" value={o.label} aria-label={t('fb.opt.label', { n: i + 1 })}
                  onChange={e => set(i, { label: e.target.value, ...(locked || o.value !== keyFromLabel(o.label) && !/^option_\d+$/.test(o.value) ? {} : { value: keyFromLabel(e.target.value).slice(0, 100) }) })}
                  data-testid={`prop-option-label-${i}`} />
                <Button variant="ghost" size="icon-sm" className="size-7" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('fb.opt.up')}><ArrowUp /></Button>
                <Button variant="ghost" size="icon-sm" className="size-7" disabled={i === opts.length - 1} onClick={() => move(i, 1)} aria-label={t('fb.opt.down')}><ArrowDown /></Button>
                <Button variant="ghost" size="icon-sm" className="size-7 hover:text-danger" disabled={locked || opts.length <= 1} onClick={() => onChange(opts.filter((_, j) => j !== i))}
                  aria-label={t('fb.opt.remove', { label: o.label })} title={locked ? t('fb.opt.lockedHint') : undefined}><Trash2 /></Button>
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <Input className={cn('h-7 flex-1 font-mono text-xs', dupes.has(o.value) && 'border-danger')} value={o.value} disabled={locked}
                  aria-label={t('fb.opt.value', { n: i + 1 })} onChange={e => set(i, { value: e.target.value.replace(/\s/g, '_').slice(0, 100) })} />
                <NativeSelect className="h-7 w-24 text-xs" value={o.color ?? 'neutral'} aria-label={t('fb.opt.color')} onChange={e => set(i, { color: e.target.value as Opt['color'] })}>
                  {(['neutral', 'blue', 'green', 'amber', 'red'] as const).map(c => <option key={c} value={c}>{t(`fb.color.${c}` as 'fb.color.neutral')}</option>)}
                </NativeSelect>
                <label className="flex items-center gap-1 text-xs text-fg-muted">
                  <input type="checkbox" checked={!!o.inactive} onChange={e => set(i, { inactive: e.target.checked || undefined })} className="accent-[rgb(var(--c-accent))]" />
                  {t('fb.opt.inactive')}
                </label>
              </div>
              {dupes.has(o.value) && <p className="mt-1 text-xs text-danger">{t('fb.opt.duplicate')}</p>}
            </li>
          );
        })}
      </ul>
      {bulk === null ? (
        <div className="flex gap-1.5">
          <Button size="sm" variant="secondary" onClick={add} data-testid="prop-option-add"><Plus aria-hidden />{t('fb.opt.add')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setBulk('')}><ClipboardPaste aria-hidden />{t('fb.opt.paste')}</Button>
        </div>
      ) : (
        <div className="space-y-1.5">
          <textarea className="min-h-24 w-full rounded border border-border-strong bg-surface p-2 text-sm" value={bulk} onChange={e => setBulk(e.target.value)}
            placeholder={t('fb.opt.pastePlaceholder')} aria-label={t('fb.opt.paste')} />
          <div className="flex gap-1.5">
            <Button size="sm" onClick={applyBulk}>{t('fb.opt.pasteAdd')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setBulk(null)}>{t('common.cancel')}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
