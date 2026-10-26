'use client';
import { Skeleton } from '@procure/ui';
import dynamic from 'next/dynamic';
import type { FormulaEditorProps } from './formula-editor';

export type { FormulaEditorProps };

/** Lazy CodeMirror formula editor (keeps CodeMirror out of every route bundle that doesn't edit formulas). */
export const FormulaEditor = dynamic<FormulaEditorProps>(() => import('./formula-editor').then(m => m.FormulaEditor), {
  ssr: false,
  loading: () => <Skeleton className="h-9 w-full" />,
});
