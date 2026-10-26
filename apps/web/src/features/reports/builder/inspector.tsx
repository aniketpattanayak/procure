'use client';
import { Button, Checkbox, FormField, Input, Label, NativeSelect, Segmented, Switch } from '@procure/ui';
import { Trash2 } from 'lucide-react';
import { useId } from 'react';
import { t } from '@/i18n';
import { DateRangeInput, LocationInput } from '../param-bar';
import { chartIcon } from '../reports-home';
import type { CatalogueField, ChartType, ReportColumnDef, ReportDefinition, ReportFilterDef } from '../types';
import { aggregatesFor, isDateType, isNumeric, opsFor, opTakesValue, paramKey, type Selection } from './model';

const FORMATS: ReportColumnDef['format'][] = ['auto', 'number', 'currency', 'percent', 'date', 'datetime', 'text'];
const CHARTS: ChartType[] = ['bar', 'stacked_bar', 'line', 'area', 'pie'];

function Panel({ title, children, onRemove, testId }: { title: string; children: React.ReactNode; onRemove?: () => void; testId: string }) {
  return (
    <div className="space-y-4" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate font-semibold">{title}</h3>
        {onRemove && <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label={t('builder.remove')} data-testid={`${testId}-remove`}><Trash2 aria-hidden /></Button>}
      </div>
      {children}
    </div>
  );
}

function ColumnEditor({ col, field, onChange }: { col: ReportColumnDef; field?: CatalogueField; onChange: (c: ReportColumnDef) => void }) {
  return (
    <>
      <FormField label={t('builder.col.label')} hint={t('builder.col.labelHint', { label: field?.label ?? col.field })}>
        <Input value={col.label ?? ''} placeholder={field?.label} maxLength={80} onChange={e => onChange({ ...col, label: e.target.value })} data-testid="builder-col-label" />
      </FormField>
      <FormField label={t('builder.col.aggregate')}>
        <NativeSelect value={col.aggregate} onChange={e => onChange({ ...col, aggregate: e.target.value as ReportColumnDef['aggregate'] })} data-testid="builder-col-aggregate">
          {aggregatesFor(field).map(a => <option key={a} value={a}>{t(`builder.agg.${a}` as 'builder.agg.sum')}</option>)}
        </NativeSelect>
      </FormField>
      <FormField label={t('builder.col.format')}>
        <NativeSelect value={col.format} onChange={e => onChange({ ...col, format: e.target.value as ReportColumnDef['format'] })} data-testid="builder-col-format">
          {FORMATS.map(f => <option key={f} value={f}>{t(`builder.fmt.${f}` as 'builder.fmt.auto')}</option>)}
        </NativeSelect>
      </FormField>
      <FormField label={t('builder.col.width')} hint={t('builder.col.widthHint')}>
        <Input type="number" min={40} max={800} step={10} value={col.width ?? ''} onChange={e => onChange({ ...col, width: e.target.value ? Math.min(800, Math.max(40, Number(e.target.value))) : undefined })} data-testid="builder-col-width" />
      </FormField>
    </>
  );
}

function FilterValue({ f, field, onChange }: { f: ReportFilterDef; field?: CatalogueField; onChange: (v: unknown) => void }) {
  const id = useId();
  const v = f.value;
  if (!opTakesValue(f.op)) return null;
  if (f.op === 'within_location') return <FormField label={t('builder.filter.value')}><LocationInput id={id} value={v} onChange={onChange} testId="builder-filter-value" /></FormField>;
  if (f.op === 'between' && isDateType(field?.type)) return <DateRangeInput value={v} onChange={onChange} label={t('builder.filter.value')} testId="builder-filter-value" idBase={id} />;
  if (field?.type === 'boolean') {
    return (
      <FormField label={t('builder.filter.value')}>
        <NativeSelect value={v === true ? 'true' : v === false ? 'false' : ''} onChange={e => onChange(e.target.value === '' ? undefined : e.target.value === 'true')} data-testid="builder-filter-value">
          <option value="">—</option><option value="true">{t('report.yes')}</option><option value="false">{t('report.no')}</option>
        </NativeSelect>
      </FormField>
    );
  }
  if (f.op === 'between') {
    const r = Array.isArray(v) ? v : [];
    return (
      <FormField label={t('builder.filter.value')}>
        <div className="flex items-center gap-1.5">
          <Input type="number" aria-label={t('builder.filter.min')} value={String(r[0] ?? '')} onChange={e => onChange([e.target.value, r[1] ?? ''])} data-testid="builder-filter-value-from" />
          <span aria-hidden>–</span>
          <Input type="number" aria-label={t('builder.filter.max')} value={String(r[1] ?? '')} onChange={e => onChange([r[0] ?? '', e.target.value])} data-testid="builder-filter-value-to" />
        </div>
      </FormField>
    );
  }
  const list = f.op === 'in' || f.op === 'not_in';
  return (
    <FormField label={t('builder.filter.value')} hint={list ? t('report.param.listHint') : undefined}>
      <Input type={isDateType(field?.type) ? 'date' : isNumeric(field?.type) ? 'number' : 'text'} value={Array.isArray(v) ? v.join(', ') : String(v ?? '')}
        onChange={e => onChange(list ? e.target.value.split(',').map(s => s.trim()).filter(Boolean) : e.target.value)} data-testid="builder-filter-value" />
    </FormField>
  );
}

function FilterEditor({ f, field, onChange }: { f: ReportFilterDef; field?: CatalogueField; onChange: (f: ReportFilterDef) => void }) {
  const ops = opsFor(field);
  const exposed = !!f.param;
  return (
    <>
      <FormField label={t('builder.filter.op')}>
        <NativeSelect value={f.op} onChange={e => onChange({ ...f, op: e.target.value as ReportFilterDef['op'], value: undefined })} data-testid="builder-filter-op">
          {ops.map(o => <option key={o} value={o}>{t(`builder.op.${o}` as 'builder.op.eq')}</option>)}
        </NativeSelect>
      </FormField>
      <FilterValue f={f} field={field} onChange={value => onChange({ ...f, value })} />
      {opTakesValue(f.op) && (
        <div className="space-y-3 rounded border border-border bg-subtle/60 p-3">
          <label className="flex items-start gap-2.5">
            <Switch checked={exposed} onCheckedChange={on => onChange({ ...f, param: on ? { key: paramKey(field?.label ?? f.field), label: field?.label ?? f.field, required: false } : undefined })} data-testid="builder-filter-param" />
            <span><span className="block font-medium">{t('builder.filter.expose')}</span><span className="block text-sm text-fg-muted">{t('builder.filter.exposeHint')}</span></span>
          </label>
          {f.param && (
            <>
              <FormField label={t('builder.filter.paramLabel')}>
                <Input value={f.param.label} maxLength={60} onChange={e => onChange({ ...f, param: { ...f.param!, label: e.target.value } })} data-testid="builder-filter-param-label" />
              </FormField>
              <FormField label={t('builder.filter.paramKey')} hint={t('builder.filter.paramKeyHint')}>
                <Input value={f.param.key} maxLength={31} className="font-mono" onChange={e => onChange({ ...f, param: { ...f.param!, key: e.target.value } })} data-testid="builder-filter-param-key" />
              </FormField>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={f.param.required} onCheckedChange={v => onChange({ ...f, param: { ...f.param!, required: v === true } })} data-testid="builder-filter-param-required" />
                {t('builder.filter.paramRequired')}
              </label>
            </>
          )}
        </div>
      )}
    </>
  );
}

export function ChartEditor({ def, fields, onChange }: { def: ReportDefinition; fields: Map<string, CatalogueField>; onChange: (c: ReportDefinition['chart']) => void }) {
  const chart = def.chart;
  const label = (id: string) => def.columns.find(c => c.field === id)?.label || fields.get(id)?.label || id;
  const xOptions = def.columns.filter(c => c.aggregate === 'none' && !isNumeric(fields.get(c.field)?.type)).map(c => c.field);
  const seriesOptions = def.columns.filter(c => c.aggregate !== 'none' || isNumeric(fields.get(c.field)?.type)).map(c => c.field);
  const type: ChartType | 'none' = chart?.type ?? 'none';
  return (
    <Panel title={t('builder.chart.title')} testId="builder-chart-panel">
      <FormField label={t('builder.chart.type')}>
        <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label={t('builder.chart.type')} data-testid="builder-chart-type">
          {(['none', ...CHARTS] as const).map(c => {
            const Icon = c === 'none' ? null : chartIcon[c];
            const on = type === c;
            return (
              <button key={c} type="button" role="radio" aria-checked={on} data-testid={`builder-chart-type-${c}`}
                className={`flex flex-col items-center gap-1 rounded border px-2 py-2 text-sm ${on ? 'border-accent bg-accent-soft text-accent' : 'border-border hover:bg-subtle'}`}
                onClick={() => onChange(c === 'none' ? undefined : { type: c, x: chart?.x && xOptions.includes(chart.x) ? chart.x : xOptions[0] ?? def.columns[0]?.field ?? '', series: chart?.series?.filter(s => seriesOptions.includes(s)).length ? chart.series.filter(s => seriesOptions.includes(s)).slice(0, c === 'pie' ? 1 : 6) : seriesOptions.slice(0, 1) })}>
                {Icon ? <Icon className="size-4" aria-hidden /> : <span className="size-4 text-center leading-4" aria-hidden>–</span>}
                {t(`report.chart.type.${c}` as 'report.chart.type.bar')}
              </button>
            );
          })}
        </div>
      </FormField>
      {chart && (
        <>
          <FormField label={t('builder.chart.x')}>
            <NativeSelect value={chart.x} onChange={e => onChange({ ...chart, x: e.target.value })} data-testid="builder-chart-x">
              {!xOptions.includes(chart.x) && <option value={chart.x}>{label(chart.x)}</option>}
              {xOptions.map(x => <option key={x} value={x}>{label(x)}</option>)}
            </NativeSelect>
          </FormField>
          <fieldset className="space-y-1.5" data-testid="builder-chart-series">
            <legend className="mb-1 text-sm font-medium">{t('builder.chart.series')}</legend>
            {seriesOptions.length === 0 && <p className="text-sm text-fg-muted">{t('builder.chart.noSeries')}</p>}
            {seriesOptions.map(s => {
              const checked = chart.series.includes(s);
              const max = chart.type === 'pie' ? 1 : 6;
              return (
                <label key={s} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={checked} disabled={!checked && chart.series.length >= max && chart.type !== 'pie'} data-testid={`builder-chart-series-${s}`}
                    onCheckedChange={v => onChange({ ...chart, series: chart.type === 'pie' ? [s] : v ? [...chart.series, s] : chart.series.filter(x => x !== s) })} />
                  {label(s)}
                </label>
              );
            })}
            <p className="text-xs text-fg-subtle">{chart.type === 'pie' ? t('builder.chart.pieHint') : t('builder.chart.seriesHint')}</p>
          </fieldset>
        </>
      )}
    </Panel>
  );
}

export function SettingsEditor({ def, onChange }: { def: ReportDefinition; onChange: (d: Partial<ReportDefinition>) => void }) {
  return (
    <Panel title={t('builder.settings.title')} testId="builder-settings-panel">
      <label className="flex items-center justify-between gap-3">
        <span><span className="block font-medium">{t('builder.settings.totals')}</span><span className="block text-sm text-fg-muted">{t('builder.settings.totalsHint')}</span></span>
        <Switch checked={def.totals} onCheckedChange={v => onChange({ totals: v })} data-testid="builder-totals" />
      </label>
      <FormField label={t('builder.settings.period')} hint={t('builder.settings.periodHint')}>
        <NativeSelect value={def.datePreset} onChange={e => onChange({ datePreset: e.target.value as ReportDefinition['datePreset'] })} data-testid="builder-date-preset">
          <option value="none">{t('report.param.anyTime')}</option>
          {(['today', 'this_week', 'this_month', 'last_month', 'last_30_days', 'last_90_days', 'this_fy'] as const).map(p => <option key={p} value={p}>{t(`report.preset.${p}` as 'report.preset.today')}</option>)}
        </NativeSelect>
      </FormField>
      <FormField label={t('builder.settings.rowLimit')} hint={t('builder.settings.rowLimitHint')}>
        <Input type="number" min={1} max={100000} value={def.rowLimit} onChange={e => onChange({ rowLimit: Math.min(100_000, Math.max(1, Number(e.target.value) || 1)) })} data-testid="builder-row-limit" />
      </FormField>
    </Panel>
  );
}

/** Right-hand panel: edits whatever is selected on the shelves, or the chart / report settings. */
export function Inspector({ def, fields, selection, setDef, onRemove }: {
  def: ReportDefinition; fields: Map<string, CatalogueField>; selection: Selection; setDef: (fn: (d: ReportDefinition) => ReportDefinition) => void; onRemove: () => void;
}) {
  if (!selection) return <p className="py-6 text-center text-sm text-fg-muted" data-testid="builder-inspector-empty">{t('builder.inspector.empty')}</p>;
  if ('panel' in selection) {
    if (selection.panel === 'chart') return <ChartEditor def={def} fields={fields} onChange={chart => setDef(d => ({ ...d, chart }))} />;
    return <SettingsEditor def={def} onChange={p => setDef(d => ({ ...d, ...p }))} />;
  }
  const { shelf, index } = selection;
  if (shelf === 'columns') {
    const col = def.columns[index];
    if (!col) return null;
    const field = fields.get(col.field);
    return (
      <Panel title={field?.label ?? col.field} onRemove={onRemove} testId="builder-col-panel">
        <p className="-mt-3 text-sm text-fg-muted">{t('builder.inspector.column')}</p>
        <ColumnEditor col={col} field={field} onChange={c => setDef(d => ({ ...d, columns: d.columns.map((x, i) => (i === index ? c : x)) }))} />
      </Panel>
    );
  }
  if (shelf === 'filters') {
    const f = def.filters[index];
    if (!f) return null;
    const field = fields.get(f.field);
    return (
      <Panel title={field?.label ?? f.field} onRemove={onRemove} testId="builder-filter-panel">
        <p className="-mt-3 text-sm text-fg-muted">{t('builder.inspector.filter')}</p>
        <FilterEditor f={f} field={field} onChange={nf => setDef(d => ({ ...d, filters: d.filters.map((x, i) => (i === index ? nf : x)) }))} />
      </Panel>
    );
  }
  if (shelf === 'sort') {
    const s = def.sort[index];
    if (!s) return null;
    return (
      <Panel title={fields.get(s.field)?.label ?? s.field} onRemove={onRemove} testId="builder-sort-panel">
        <Label>{t('builder.sort.direction')}</Label>
        <Segmented<'asc' | 'desc'> label={t('builder.sort.direction')} value={s.dir} onChange={dir => setDef(d => ({ ...d, sort: d.sort.map((x, i) => (i === index ? { ...x, dir } : x)) }))}
          options={[{ value: 'asc', label: t('builder.sortAsc') }, { value: 'desc', label: t('builder.sortDesc') }]} />
      </Panel>
    );
  }
  const g = def.groupBy[index];
  if (!g) return null;
  return (
    <Panel title={fields.get(g)?.label ?? g} onRemove={onRemove} testId="builder-group-panel">
      <p className="text-sm text-fg-muted">{index === 0 && def.groupBy.length > 1 ? t('builder.group.firstHint') : t('builder.group.hint')}</p>
    </Panel>
  );
}
