'use client';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { useSyncExternalStore, type ReactNode } from 'react';
import { cn } from '../lib/cn';

type Tone = 'success' | 'error' | 'info';
interface ToastItem { id: number; title: ReactNode; description?: ReactNode; tone: Tone }

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

/** Imperative toast API usable anywhere (mutations, query error handlers). */
export const toast = Object.assign(
  (title: ReactNode, opts: { description?: ReactNode; tone?: Tone } = {}) => {
    items = [...items, { id: ++seq, title, description: opts.description, tone: opts.tone ?? 'info' }];
    emit();
  },
  {
    success: (title: ReactNode, description?: ReactNode) => toast(title, { description, tone: 'success' }),
    error: (title: ReactNode, description?: ReactNode) => toast(title, { description, tone: 'error' }),
  },
);

function dismiss(id: number) {
  items = items.filter(t => t.id !== id);
  emit();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
const snapshot = () => items;
const empty: ToastItem[] = [];

const icons = { success: CheckCircle2, error: AlertCircle, info: Info };

export function Toaster({ closeLabel = 'Dismiss' }: { closeLabel?: string }) {
  const list = useSyncExternalStore(subscribe, snapshot, () => empty);
  return (
    <ToastPrimitive.Provider swipeDirection="right" duration={5000}>
      {list.map(t => {
        const Icon = icons[t.tone];
        return (
          <ToastPrimitive.Root
            key={t.id}
            type={t.tone === 'error' ? 'foreground' : 'background'}
            onOpenChange={open => { if (!open) dismiss(t.id); }}
            className="flex w-full items-start gap-3 rounded-lg border border-border bg-surface p-3.5 shadow-pop animate-pop-in data-[swipe=end]:animate-fade-in"
          >
            <Icon className={cn('mt-0.5 size-4 shrink-0', t.tone === 'success' && 'text-success', t.tone === 'error' && 'text-danger', t.tone === 'info' && 'text-accent')} aria-hidden />
            <div className="min-w-0 flex-1">
              <ToastPrimitive.Title className="text-base font-medium">{t.title}</ToastPrimitive.Title>
              {t.description && <ToastPrimitive.Description className="mt-0.5 text-sm text-fg-muted">{t.description}</ToastPrimitive.Description>}
            </div>
            <ToastPrimitive.Close className="rounded p-0.5 text-fg-subtle hover:text-fg" aria-label={closeLabel}><X className="size-4" /></ToastPrimitive.Close>
          </ToastPrimitive.Root>
        );
      })}
      <ToastPrimitive.Viewport className="fixed bottom-0 right-0 z-[100] flex w-full flex-col gap-2 p-4 outline-none sm:max-w-sm" />
    </ToastPrimitive.Provider>
  );
}
