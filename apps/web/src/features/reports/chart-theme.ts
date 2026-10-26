'use client';
import { useEffect, useState } from 'react';

/**
 * Chart palette (dataviz reference instance), validated with validate_palette.js against this app's surfaces:
 * light #FFFFFF (all checks pass; aqua/yellow/magenta < 3:1 so the results table is always shown beside the chart)
 * and dark #181C22 (all pass). Slots are assigned in fixed order by series identity, never cycled; a 7th+ series
 * folds into "Other" (neutral).
 */
export const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];
export const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'];
export const MAX_SERIES = 6;

export interface ChartInk { series: string[]; other: string; surface: string; grid: string; axis: string; muted: string; text: string; textMuted: string }
const LIGHT: ChartInk = { series: SERIES_LIGHT, other: '#9aa1ab', surface: '#ffffff', grid: '#e8eaee', axis: '#c4cad2', muted: '#636b78', text: '#1f2328', textMuted: '#575f6c' };
const DARK: ChartInk = { series: SERIES_DARK, other: '#6b7380', surface: '#181c22', grid: '#2a3038', axis: '#444c58', muted: '#8a939f', text: '#e6e9ed', textMuted: '#a5adb8' };

function computeDark() {
  if (typeof document === 'undefined') return false;
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark') return true;
  if (attr === 'light') return false;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

/** Selected ink for the current theme; follows the theme toggle and the OS setting. */
export function useChartInk(): ChartInk {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(computeDark());
    const update = () => setDark(computeDark());
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener?.('change', update);
    return () => { mo.disconnect(); mq?.removeEventListener?.('change', update); };
  }, []);
  return dark ? DARK : LIGHT;
}
