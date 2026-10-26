import { cn } from '../lib/cn';

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  /** Accessible summary, e.g. "Rate trend: 52 to 49". Rendered as the SVG title. */
  label: string;
  /** Mark the last point. */
  showLast?: boolean;
  className?: string;
  'data-testid'?: string;
}

/** Tiny inline trend line (currentColor). Values are plotted left to right, min..max scaled to the height. */
export function Sparkline({ values, width = 88, height = 24, label, showLast = true, className, ...rest }: SparklineProps) {
  const pad = 2.5;
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const pts = values.map((v, i) => [pad + i * step, height - pad - ((v - min) / span) * (height - pad * 2)] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1]!;
  return (
    <svg role="img" width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn('shrink-0 overflow-visible', className)} data-testid={rest['data-testid']}>
      <title>{label}</title>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {showLast && <circle cx={last[0]} cy={last[1]} r={2.25} fill="currentColor" />}
    </svg>
  );
}
