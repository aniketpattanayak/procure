'use client';
import { cn } from '@procure/ui';
import { useMemo } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
  type TooltipProps,
} from 'recharts';
import { t } from '@/i18n';
import { type ChartModel, toRows } from './chart-data';
import { MAX_SERIES, useChartInk, type ChartInk } from './chart-theme';
import { formatCompact, formatValue } from './format';

const color = (ink: ChartInk, i: number, other?: boolean) => (other ? ink.other : ink.series[i % ink.series.length]!);

/** Legend: always present for 2+ series (identity is never colour alone); mirrors the mark (rect for bars, line for lines). */
function Legend({ items, ink, mark }: { items: { name: string; other?: boolean }[]; ink: ChartInk; mark: 'rect' | 'line' }) {
  if (items.length < 2) return null;
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-muted" aria-label={t('report.chart.legend')}>
      {items.map((s, i) => (
        <li key={`${s.name}-${i}`} className="flex items-center gap-1.5">
          {mark === 'rect'
            ? <span aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: color(ink, i, s.other) }} />
            : <span aria-hidden className="inline-block h-0.5 w-3.5 rounded" style={{ background: color(ink, i, s.other) }} />}
          <span className="max-w-[16rem] truncate">{s.name}</span>
        </li>
      ))}
    </ul>
  );
}

function TooltipBox({ active, payload, label, model, ink }: TooltipProps<number, string> & { model: ChartModel; ink: ChartInk }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-36 rounded border border-border bg-surface px-3 py-2 text-sm shadow-pop">
      <p className="mb-1 font-medium text-fg">{model.type === 'pie' ? payload[0]?.name : label}</p>
      <ul className="space-y-0.5">
        {payload.map((p, i) => {
          const s = model.series.find(x => x.key === p.dataKey);
          const idx = s ? model.series.indexOf(s) : i;
          return (
            <li key={String(p.dataKey ?? i)} className="flex items-center gap-2">
              <span aria-hidden className="inline-block h-0.5 w-3 rounded" style={{ background: model.type === 'pie' ? (p.payload as { fill?: string })?.fill : color(ink, idx, s?.other) }} />
              <span className="font-semibold tabular-nums text-fg">{formatValue(p.value, model.format)}</span>
              {model.type !== 'pie' && <span className="truncate text-fg-muted">{s?.name ?? p.name}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Report chart (bar, stacked bar, line, area, pie). The results table beside it is the accessible table view. */
export function ReportChart({ model, height = 300, className, compact }: { model: ChartModel; height?: number; className?: string; compact?: boolean }) {
  const ink = useChartInk();
  const rows = useMemo(() => toRows(model), [model]);
  const axis = { stroke: ink.axis, tick: { fill: ink.muted, fontSize: 12 }, tickLine: false } as const;
  const yTick = (v: number) => formatCompact(v, model.format);
  const tooltip = <Tooltip cursor={model.type === 'line' || model.type === 'area' ? { stroke: ink.axis, strokeWidth: 1 } : { fill: ink.grid, opacity: 0.5 }} content={<TooltipBox model={model} ink={ink} />} isAnimationActive={false} />;
  const summary = t('report.chart.summary', { type: t(`report.chart.type.${model.type}` as 'report.chart.type.bar'), series: model.series.map(s => s.name).join(', '), x: model.xLabel, n: model.categories.length });
  const many = model.categories.length > 8;
  // Ticks thin out on narrow charts (minTickGap) instead of overlapping; long category names are shortened.
  const xAxis = <XAxis dataKey="x" {...axis} interval="preserveStartEnd" minTickGap={12} angle={many && !compact ? -30 : 0} textAnchor={many && !compact ? 'end' : 'middle'} height={many && !compact ? 56 : 28} tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)} />;
  const yAxis = <YAxis {...axis} axisLine={false} width={52} tickFormatter={yTick} />;
  const grid = <CartesianGrid vertical={false} stroke={ink.grid} strokeWidth={1} />;
  const margin = { top: 8, right: 12, bottom: 0, left: 0 };

  let chart: React.ReactElement;
  if (model.type === 'pie') {
    const s = model.series[0];
    const raw = model.categories.map((c, i) => ({ name: c, value: Math.max(0, s?.values[i] ?? 0) }));
    const sorted = [...raw].sort((a, b) => b.value - a.value);
    const slices = sorted.length > MAX_SERIES
      ? [...sorted.slice(0, MAX_SERIES - 1), { name: t('report.chart.other'), value: sorted.slice(MAX_SERIES - 1).reduce((a, x) => a + x.value, 0), other: true }]
      : sorted;
    return (
      <figure className={cn('w-full', className)} aria-label={summary}>
        <Legend items={slices} ink={ink} mark="rect" />
        <div style={{ height }} role="img" aria-label={summary}>
          <ResponsiveContainer>
            <PieChart>
              {tooltip}
              <Pie data={slices} dataKey="value" nameKey="name" innerRadius="52%" outerRadius="88%" stroke={ink.surface} strokeWidth={2} isAnimationActive={false}>
                {slices.map((sl, i) => <Cell key={sl.name} fill={color(ink, i, 'other' in sl)} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>
      </figure>
    );
  } else if (model.type === 'line') {
    chart = (
      <LineChart data={rows} margin={margin}>
        {grid}{xAxis}{yAxis}{tooltip}
        {model.series.map((s, i) => (
          <Line key={s.key} dataKey={s.key} name={s.name} type="monotone" stroke={color(ink, i, s.other)} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
            dot={rows.length <= 24 ? { r: 4, fill: color(ink, i, s.other), stroke: ink.surface, strokeWidth: 2 } : false}
            activeDot={{ r: 5, fill: color(ink, i, s.other), stroke: ink.surface, strokeWidth: 2 }} isAnimationActive={false} />
        ))}
      </LineChart>
    );
  } else if (model.type === 'area') {
    chart = (
      <AreaChart data={rows} margin={margin}>
        {grid}{xAxis}{yAxis}{tooltip}
        {model.series.map((s, i) => (
          <Area key={s.key} dataKey={s.key} name={s.name} type="monotone" stroke={color(ink, i, s.other)} strokeWidth={2} fill={color(ink, i, s.other)} fillOpacity={0.1} isAnimationActive={false}
            activeDot={{ r: 5, fill: color(ink, i, s.other), stroke: ink.surface, strokeWidth: 2 }} />
        ))}
      </AreaChart>
    );
  } else {
    const stacked = model.type === 'stacked_bar';
    const last = model.series.length - 1;
    chart = (
      <BarChart data={rows} margin={margin} barGap={2} barCategoryGap="22%">
        {grid}{xAxis}{yAxis}{tooltip}
        {model.series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.name} fill={color(ink, i, s.other)} maxBarSize={24} stackId={stacked ? 'a' : undefined}
            radius={!stacked || i === last ? [4, 4, 0, 0] : 0} stroke={stacked ? ink.surface : undefined} strokeWidth={stacked ? 1 : 0} isAnimationActive={false} />
        ))}
      </BarChart>
    );
  }

  return (
    <figure className={cn('w-full', className)}>
      <Legend items={model.series} ink={ink} mark={model.type === 'line' ? 'line' : 'rect'} />
      <div style={{ height }} role="img" aria-label={summary}>
        <ResponsiveContainer>{chart}</ResponsiveContainer>
      </div>
    </figure>
  );
}
