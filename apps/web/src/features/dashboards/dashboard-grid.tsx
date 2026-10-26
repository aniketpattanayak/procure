'use client';
import { cn } from '@procure/ui';
import type { CSSProperties, ReactNode } from 'react';
import type { DashboardWidget } from '@/features/reports/types';
import { GAP_PX, pixelHeight, readingOrder, ROW_PX } from './grid';

/**
 * 12-column grid from lg up (each widget at x/y/w/h); below lg widgets stack in reading order, two KPI tiles per row
 * on tablets, each keeping its designed height so charts stay legible.
 */
export function DashboardGrid({ widgets, render, className, testId = 'dash-grid' }: { widgets: DashboardWidget[]; render: (w: DashboardWidget) => ReactNode; className?: string; testId?: string }) {
  const rows = widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
  return (
    <div
      className={cn('grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-12', className)}
      style={{ '--dash-row': `${ROW_PX}px`, gridTemplateRows: undefined } as CSSProperties}
      data-testid={testId}
    >
      {readingOrder(widgets).map(w => (
        <div
          key={w.id}
          className={cn('dash-cell min-w-0', w.type === 'kpi' ? 'sm:col-span-1' : 'sm:col-span-2')}
          style={{ '--x': w.x + 1, '--w': w.w, '--y': w.y + 1, '--h': w.h, '--hpx': `${pixelHeight(w.h)}px` } as CSSProperties}
          data-testid={`dash-cell-${w.id}`}
        >
          {render(w)}
        </div>
      ))}
      <style>{`
        .dash-cell { height: var(--hpx); }
        @media (min-width: 1024px) {
          [data-testid="${testId}"] { grid-auto-rows: ${ROW_PX}px; row-gap: ${GAP_PX}px; min-height: ${pixelHeight(Math.max(rows, 1))}px; }
          [data-testid="${testId}"] > .dash-cell { grid-column: var(--x) / span var(--w); grid-row: var(--y) / span var(--h); height: auto; }
        }
      `}</style>
    </div>
  );
}
