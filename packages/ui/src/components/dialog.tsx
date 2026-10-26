'use client';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { type ComponentProps, type MutableRefObject, type ReactNode, useRef, useState } from 'react';
import { cn } from '../lib/cn';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

function Overlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return <DialogPrimitive.Overlay className={cn('fixed inset-0 z-50 bg-black/40 animate-fade-in', className)} {...props} />;
}

/**
 * A11Y8-001 (WCAG 2.4.3): Radix only returns focus to a `Dialog.Trigger`. Our dialogs are opened from state (no
 * Trigger), so on close focus fell to <body>. `Remember` mounts with the content and records the element that had
 * focus *before* Radix moves it (state initialisers run during render, before the focus-scope effect); on close focus
 * goes back there.
 */
function Remember({ into }: { into: MutableRefObject<HTMLElement | null> }) {
  useState(() => { into.current = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null; return null; });
  return null;
}
function useRestoreFocus(onCloseAutoFocus?: (e: Event) => void) {
  const restore = useRef<HTMLElement | null>(null);
  const handler = (e: Event) => {
    onCloseAutoFocus?.(e);
    if (e.defaultPrevented) return;
    const el = restore.current;
    if (el && el.isConnected && el !== document.body) {
      e.preventDefault();
      el.focus();
    }
  };
  return { restore, handler };
}

export interface DialogContentProps extends Omit<ComponentProps<typeof DialogPrimitive.Content>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  closeLabel?: string;
}

/** Centered on desktop; becomes a bottom sheet on small screens. */
export function DialogContent({ className, children, title, description, footer, size = 'md', closeLabel = 'Close', onCloseAutoFocus, ...props }: DialogContentProps) {
  const { restore, handler } = useRestoreFocus(onCloseAutoFocus);
  return (
    <DialogPrimitive.Portal>
      <Overlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-50 flex max-h-[92dvh] w-full flex-col border border-border bg-surface shadow-pop animate-pop-in',
          'inset-x-0 bottom-0 rounded-t-lg sm:inset-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg',
          size === 'sm' && 'sm:max-w-sm',
          size === 'md' && 'sm:max-w-lg',
          size === 'lg' && 'sm:max-w-2xl',
          className,
        )}
        onCloseAutoFocus={handler}
        {...props}
      >
        <Remember into={restore} />
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="space-y-1">
            <DialogPrimitive.Title className="text-md font-semibold">{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="text-sm text-fg-muted">{description}</DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close className="-mr-1 rounded p-1 text-fg-subtle hover:bg-muted hover:text-fg" aria-label={closeLabel}>
            <X className="size-4" />
          </DialogPrimitive.Close>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-3 sm:flex-row sm:justify-end">{footer}</div>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export interface SheetContentProps extends Omit<ComponentProps<typeof DialogPrimitive.Content>, 'title'> {
  side?: 'left' | 'right';
  title: ReactNode;
  hideTitle?: boolean;
  closeLabel?: string;
}

/** Sheet / drawer: same primitive as Dialog, docked to an edge. */
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export function SheetContent({ side = 'left', className, children, title, hideTitle, closeLabel = 'Close', onCloseAutoFocus, ...props }: SheetContentProps) {
  const { restore, handler } = useRestoreFocus(onCloseAutoFocus);
  return (
    <DialogPrimitive.Portal>
      <Overlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-y-0 z-50 flex w-[85vw] max-w-sm flex-col border-border bg-surface shadow-pop',
          side === 'left' ? 'left-0 border-r animate-slide-in-left' : 'right-0 border-l animate-slide-in-right',
          className,
        )}
        onCloseAutoFocus={handler}
        {...props}
      >
        <Remember into={restore} />
        <div className={cn('flex items-center justify-between border-b border-border px-4 py-3', hideTitle && 'sr-only')}>
          <DialogPrimitive.Title className="text-md font-semibold">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          <DialogPrimitive.Close className="rounded p-1 text-fg-subtle hover:bg-muted hover:text-fg" aria-label={closeLabel}>
            <X className="size-4" />
          </DialogPrimitive.Close>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
