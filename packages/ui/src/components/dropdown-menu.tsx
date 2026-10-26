'use client';
import * as DM from '@radix-ui/react-dropdown-menu';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

export const DropdownMenu = DM.Root;
export const DropdownMenuTrigger = DM.Trigger;
export const DropdownMenuGroup = DM.Group;

export function DropdownMenuContent({ className, sideOffset = 6, align = 'end', ...props }: ComponentProps<typeof DM.Content>) {
  return (
    <DM.Portal>
      <DM.Content
        sideOffset={sideOffset}
        align={align}
        className={cn('z-50 min-w-48 overflow-hidden rounded border border-border bg-surface p-1 shadow-pop animate-pop-in', className)}
        {...props}
      />
    </DM.Portal>
  );
}

export function DropdownMenuItem({ className, destructive, ...props }: ComponentProps<typeof DM.Item> & { destructive?: boolean }) {
  return (
    <DM.Item
      className={cn(
        'flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-base outline-none data-[highlighted]:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-fg-subtle',
        destructive && 'text-danger [&_svg]:text-danger',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuCheckboxItem({ className, children, ...props }: ComponentProps<typeof DM.CheckboxItem>) {
  return (
    <DM.CheckboxItem
      className={cn('relative flex cursor-default select-none items-center gap-2 rounded-sm py-1.5 pl-8 pr-2 text-base outline-none data-[highlighted]:bg-muted', className)}
      {...props}
    >
      <span className="absolute left-2 grid size-4 place-items-center rounded-sm border border-border-strong">
        <DM.ItemIndicator><span className="block size-2 rounded-[1px] bg-accent" /></DM.ItemIndicator>
      </span>
      {children}
    </DM.CheckboxItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof DM.Label>) {
  return <DM.Label className={cn('px-2 py-1.5 text-xs font-medium text-fg-subtle', className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof DM.Separator>) {
  return <DM.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}
