'use client';
import { cn } from '@procure/ui';
import { ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { TreeNode } from './tree';

export interface TreeRowState {
  level: number;
  expanded: boolean;
  hasChildren: boolean;
  selected: boolean;
}

export interface TreeViewProps {
  roots: TreeNode[];
  label: string;
  expanded: Set<string>;
  onExpandedChange: (next: Set<string>) => void;
  /** Restrict to these ids (search). */
  visibleIds?: Set<string> | null;
  selectedId?: string | null;
  /** Enter / click on a row. */
  onSelect?: (tn: TreeNode) => void;
  /** Space on a row (e.g. toggle a checkbox). Falls back to onSelect. */
  onToggle?: (tn: TreeNode) => void;
  /** aria-checked per row when the tree is a checklist. */
  checked?: (tn: TreeNode) => boolean | 'mixed' | undefined;
  disabled?: (tn: TreeNode) => boolean;
  renderRow: (tn: TreeNode, s: TreeRowState) => ReactNode;
  rowTestId?: (tn: TreeNode) => string;
  className?: string;
  multiselectable?: boolean;
  'data-testid'?: string;
}

interface Flat { tn: TreeNode; level: number; posinset: number; setsize: number; hasChildren: boolean }

/**
 * ARIA tree (flat rendering with aria-level / aria-posinset / aria-setsize) with a roving tabindex.
 * Keys: Up/Down move, Right expands or enters, Left collapses or goes to parent, Home/End, Enter selects,
 * Space toggles (checklists), `*` expands all siblings, type-ahead by first letter.
 */
export function TreeView(props: TreeViewProps) {
  const { roots, expanded, onExpandedChange, visibleIds, selectedId, onSelect, onToggle, checked, disabled, renderRow, rowTestId, label, className, multiselectable } = props;
  const forceOpen = !!visibleIds; // searching: show every visible ancestor open

  const flat = useMemo(() => {
    const out: Flat[] = [];
    const walk = (list: TreeNode[], level: number) => {
      const shown = visibleIds ? list.filter(c => visibleIds.has(c.id)) : list;
      shown.forEach((tn, i) => {
        const kids = visibleIds ? tn.children.filter(c => visibleIds.has(c.id)) : tn.children;
        const hasChildren = kids.length > 0 || (!visibleIds && tn.node.childCount > 0 && tn.children.length > 0);
        out.push({ tn, level, posinset: i + 1, setsize: shown.length, hasChildren });
        if (hasChildren && (forceOpen || expanded.has(tn.id))) walk(tn.children, level + 1);
      });
    };
    walk(roots, 1);
    return out;
  }, [roots, expanded, visibleIds, forceOpen]);

  const [focusId, setFocusId] = useState<string | null>(null);
  const activeId = flat.some(f => f.tn.id === focusId) ? focusId : (selectedId && flat.some(f => f.tn.id === selectedId) ? selectedId : flat[0]?.tn.id ?? null);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const wantFocus = useRef(false);

  useEffect(() => {
    if (wantFocus.current && activeId) {
      refs.current.get(activeId)?.focus();
      wantFocus.current = false;
    }
  }, [activeId, flat]);

  const move = (id: string | undefined) => {
    if (!id) return;
    wantFocus.current = true;
    setFocusId(id);
    refs.current.get(id)?.focus();
  };
  const setOpen = (id: string, open: boolean) => {
    const next = new Set(expanded);
    if (open) next.add(id); else next.delete(id);
    onExpandedChange(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, f: Flat, idx: number) => {
    if (e.target !== e.currentTarget) return; // let inner controls handle their own keys
    const isOpen = f.hasChildren && (forceOpen || expanded.has(f.tn.id));
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(flat[idx + 1]?.tn.id); break;
      case 'ArrowUp': e.preventDefault(); move(flat[idx - 1]?.tn.id); break;
      case 'Home': e.preventDefault(); move(flat[0]?.tn.id); break;
      case 'End': e.preventDefault(); move(flat[flat.length - 1]?.tn.id); break;
      case 'ArrowRight':
        e.preventDefault();
        if (f.hasChildren && !isOpen) setOpen(f.tn.id, true);
        else if (isOpen) move(flat[idx + 1]?.tn.id);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (isOpen && !forceOpen) setOpen(f.tn.id, false);
        else if (f.tn.parent) move(f.tn.parent.id);
        break;
      case 'Enter': e.preventDefault(); if (!disabled?.(f.tn)) onSelect?.(f.tn); break;
      case ' ': e.preventDefault(); if (!disabled?.(f.tn)) (onToggle ?? onSelect)?.(f.tn); break;
      case '*': {
        e.preventDefault();
        const sibs = f.tn.parent ? f.tn.parent.children : roots;
        const next = new Set(expanded);
        sibs.forEach(s => { if (s.children.length) next.add(s.id); });
        onExpandedChange(next);
        break;
      }
      default:
        if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const ch = e.key.toLowerCase();
          const order = [...flat.slice(idx + 1), ...flat.slice(0, idx + 1)];
          const hit = order.find(o => o.tn.node.name.toLowerCase().startsWith(ch));
          if (hit) { e.preventDefault(); move(hit.tn.id); }
        }
    }
  };

  return (
    <div role="tree" aria-label={label} aria-multiselectable={multiselectable || undefined} className={cn('outline-none', className)} data-testid={props['data-testid']}>
      {flat.map((f, idx) => {
        const isOpen = f.hasChildren && (forceOpen || expanded.has(f.tn.id));
        const selected = selectedId === f.tn.id;
        const c = checked?.(f.tn);
        const dis = disabled?.(f.tn) ?? false;
        return (
          <div
            key={f.tn.id}
            ref={el => { if (el) refs.current.set(f.tn.id, el); else refs.current.delete(f.tn.id); }}
            role="treeitem"
            aria-level={f.level}
            aria-posinset={f.posinset}
            aria-setsize={f.setsize}
            aria-expanded={f.hasChildren ? isOpen : undefined}
            aria-selected={onSelect && !checked ? selected : undefined}
            aria-checked={c === undefined ? undefined : c === 'mixed' ? 'mixed' : c}
            aria-disabled={dis || undefined}
            tabIndex={activeId === f.tn.id ? 0 : -1}
            data-testid={rowTestId?.(f.tn)}
            onKeyDown={e => onKeyDown(e, f, idx)}
            onFocus={e => { if (e.target === e.currentTarget) setFocusId(f.tn.id); }}
            onClick={() => { setFocusId(f.tn.id); if (!dis) onSelect?.(f.tn); }}
            className={cn(
              'group flex min-h-9 cursor-default select-none items-center gap-1 rounded pr-2 outline-none',
              'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
              selected ? 'bg-accent-soft' : 'hover:bg-subtle',
              !f.tn.node.isActive && 'text-fg-muted',
            )}
            style={{ paddingLeft: `${(f.level - 1) * 1.25 + 0.25}rem` }}
          >
            {f.hasChildren ? (
              <button
                type="button"
                tabIndex={-1}
                aria-hidden
                onClick={e => { e.stopPropagation(); if (!forceOpen) setOpen(f.tn.id, !isOpen); }}
                className="grid size-6 shrink-0 place-items-center rounded text-fg-subtle hover:bg-muted hover:text-fg"
              >
                <ChevronRight className={cn('size-4 transition-transform motion-reduce:transition-none', isOpen && 'rotate-90')} />
              </button>
            ) : <span className="size-6 shrink-0" aria-hidden />}
            {renderRow(f.tn, { level: f.level, expanded: isOpen, hasChildren: f.hasChildren, selected })}
          </div>
        );
      })}
    </div>
  );
}
