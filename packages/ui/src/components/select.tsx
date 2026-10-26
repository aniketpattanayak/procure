'use client';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';
import { inputClass } from './input';

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectGroup = SelectPrimitive.Group;

export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger className={cn(inputClass, 'items-center justify-between gap-2 text-left data-[placeholder]:text-fg-subtle', className)} {...props}>
      <span className="truncate">{children}</span>
      <SelectPrimitive.Icon asChild><ChevronDown className="size-4 text-fg-subtle" aria-hidden /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({ className, children, position = 'popper', ...props }: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        sideOffset={4}
        className={cn('z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded border border-border bg-surface shadow-pop animate-pop-in', className)}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn('relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-7 pr-2 text-base outline-none data-[highlighted]:bg-muted data-[disabled]:opacity-50', className)}
      {...props}
    >
      <SelectPrimitive.ItemIndicator className="absolute left-2"><Check className="size-4" aria-hidden /></SelectPrimitive.ItemIndicator>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}
