import type { DashboardWidget, WidgetType } from '@/features/reports/types';

export const COLS = 12;
export const ROW_PX = 80;
export const GAP_PX = 16;

export const DEFAULT_SIZE: Record<WidgetType, { w: number; h: number }> = {
  kpi: { w: 3, h: 2 },
  chart: { w: 6, h: 4 },
  table: { w: 6, h: 4 },
  inbox_counts: { w: 4, h: 4 },
  doc_counts: { w: 4, h: 3 },
};
export const MIN_SIZE: Record<WidgetType, { w: number; h: number }> = {
  kpi: { w: 2, h: 2 }, chart: { w: 3, h: 3 }, table: { w: 3, h: 3 }, inbox_counts: { w: 3, h: 3 }, doc_counts: { w: 3, h: 2 },
};

type Box = Pick<DashboardWidget, 'x' | 'y' | 'w' | 'h'>;
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export function clampBox<T extends DashboardWidget>(w: T): T {
  const min = MIN_SIZE[w.type];
  const width = Math.max(min.w, Math.min(COLS, Math.round(w.w)));
  const height = Math.max(min.h, Math.min(12, Math.round(w.h)));
  return { ...w, w: width, h: height, x: Math.max(0, Math.min(COLS - width, Math.round(w.x))), y: Math.max(0, Math.round(w.y)) };
}

/**
 * Place `pinnedId` where it is, push anything it overlaps downwards, then float everything up (vertical compaction),
 * so the grid never has overlaps or gaps above a widget.
 */
export function resolveLayout(widgets: DashboardWidget[], pinnedId?: string): DashboardWidget[] {
  const items = widgets.map(clampBox);
  const pinned = items.find(w => w.id === pinnedId);
  const rest = items.filter(w => w.id !== pinnedId).sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: DashboardWidget[] = pinned ? [pinned] : [];
  for (const w of rest) {
    const cur = { ...w };
    let guard = 0;
    while (placed.some(p => overlaps(p, cur)) && guard++ < 200) cur.y = Math.max(...placed.filter(p => overlaps(p, cur)).map(p => p.y + p.h));
    placed.push(cur);
  }
  // Compact upwards in reading order (the pinned widget too, so it never floats over empty rows).
  const out: DashboardWidget[] = [];
  for (const w of [...placed].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const cur = { ...w };
    while (cur.y > 0 && !out.some(o => overlaps(o, { ...cur, y: cur.y - 1 }))) cur.y--;
    out.push(cur);
  }
  return widgets.map(w => out.find(o => o.id === w.id)!);
}

/** First free slot for a new widget of size w×h (scan rows, then columns). */
export function findSlot(widgets: DashboardWidget[], w: number, h: number): { x: number; y: number } {
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x <= COLS - w; x++) {
      const box = { x, y, w, h };
      if (!widgets.some(o => overlaps(o, box))) return { x, y };
    }
  }
  return { x: 0, y: widgets.reduce((m, o) => Math.max(m, o.y + o.h), 0) };
}

export const readingOrder = (ws: DashboardWidget[]) => [...ws].sort((a, b) => a.y - b.y || a.x - b.x);
export const pixelHeight = (h: number) => h * ROW_PX + (h - 1) * GAP_PX;

export function newWidgetId(type: WidgetType) {
  return `${type.replace('_', '-')}-${Math.random().toString(36).slice(2, 8)}`;
}
