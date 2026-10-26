# Phase 8 accessibility report — WCAG 2.2 AA

Date: 2026-10-23. Environment: local sandbox, Chromium 141 headless, `next dev --turbopack` on :3120 (`NEXT_DIST_DIR=.next-sec`,
`NODE_OPTIONS=--max-old-space-size=1280`; without the cap the dev server was OOM-killed at about 2 GB RSS), and the API
built from the working tree into `apps/api/.dist-sec` on :4120 with the acme/globex demo seed.

**Result: the main tenant and platform screens pass axe-core with no serious or critical violation (WCAG 2.0/2.1/2.2
A + AA tags) at desktop (1280 px) and 390 px, after the fixes listed below.** The core flow (sign in, create indent,
submit, approve) can be completed with the keyboard alone, and every Tab stop shows a focus indicator. Dialogs trap
focus, are labelled, close on Escape and now return focus to the control that opened them.

**8 issues: 1 critical, 7 serious.**
- Two of them are app-wide, in shared components:
  - dialogs dropped focus to `<body>` on close;
  - lookup comboboxes had no focus indicator.
- All 8 are fixed in place. Nothing is accepted as "known".

## How it was run
- Spec: `e2e/a11y-phase8.spec.ts`. Run it with:
  ```
  E2E_API_ORIGIN=http://localhost:4120 E2E_WEB_ORIGIN=http://localhost:3120 E2E_NO_RESET=1 \
  npx playwright test -c e2e/playwright.config.ts e2e/a11y-phase8.spec.ts --project=desktop-chromium --trace=off --output=<own dir>
  ```
  Use your own `--output`, because a parallel agent's run cleans the shared `test-results/e2e`.
- `A11Y_COLLECT=1` records every violation, of all impacts, to `test-results/a11y-phase8.jsonl` without failing. The
  default run fails on any serious/critical violation not in the spec's `KNOWN` list, which is empty.
- axe: `@axe-core/playwright` 4.11 with tags `wcag2a wcag2aa wcag21a wcag21aa wcag22aa`.
  - The sweep runs at desktop and at 390 × 844. The 390 px pass resizes the desktop project's viewport; the
    `mobile-pixel7` project only matches `mobile*.spec.ts`.
- Routes, tenant admin (acme):
  - `/dashboard`, `/dashboard/design`, `/approvals`;
  - indent list (document- and item-wise), new, detail and timeline; PO list and detail; `/procurement`, `/select`, `/order`;
  - GRN list, new and detail;
  - stock overview, ledger, receive, issue, reorder and opening;
  - reports home, builder (`/reports/new`) and run (`/reports/:id`); exports, messages;
  - settings, users, roles, role permissions, locations, item master;
  - form list and form builder (`/config/forms/item`), doc types, workflow list and designer (`/config/workflows/indent`);
  - templates, triggers, webhooks, numbering, audit, usage, sessions.
- Routes, platform owner: tenants (list, detail, new), plans (list, detail, new), usage, audit, providers. Also both login pages.
- Keyboard-only walkthrough:
  - It signs in with the keyboard, creates an indent through Tab, typing and ArrowDown/Enter in the lookups, and submits.
  - A second administrator then approves with the keyboard.
  - At every Tab stop it checks for a visible indicator: an opaque outline or box-shadow on the element or a wrapper
    up to 3 levels up.
  - Separately, a dialog test checks the focus trap (Tab and Shift+Tab), `aria-modal`/label, Escape, and focus return.

Final run: **7/7 passed** (keyboard flow, dialog focus, tenant sweep × 2 viewports, platform sweep × 2, login pages), with 0
violations of any impact recorded.

Two measurement notes for anyone extending the spec:
- Chrome moves focus onto its own calendar-picker button inside a date input. At that point the host no longer
  matches `:focus`, so the probe cannot read the ring. Chrome draws a UA ring on the icon (checked by screenshot), so
  the probe skips that stop.
- `settle()` waits for a non-empty `<title>`, because `/procurement` is a server redirect and axe otherwise caught the
  page mid-redirect.

## Findings

| Id | WCAG | Impact | Status | Where | Summary |
|---|---|---|---|---|---|
| A11Y8-001 | 2.4.3 Focus Order | serious | Fixed | `packages/ui` Dialog / Sheet (all dialogs) | On close, focus went to `<body>`: Radix only restores focus to a `Dialog.Trigger`, and every dialog in the app is opened from state |
| A11Y8-002 | 2.4.7 Focus Visible | serious | Fixed | `packages/ui` Input (`type=date/time`) | No ring on date/time inputs: the ring used `:focus-visible`, which Chrome does not match on the host while focus is in the date segments |
| A11Y8-004 | 2.4.7 Focus Visible | serious | Fixed | form-renderer Combobox (every lookup: location, department, item, vendor …) | The inner `<input>` is `outline-none`, and the wrapper's `focus-visible:` ring never applies to a `<div>`, so lookups had no focus indicator |
| A11Y8-003 | 2.1.1 Keyboard (axe `scrollable-region-focusable`) | serious | Fixed | document lines table (PO, GRN detail …), report results table, `packages/ui` DataTable | Horizontally/vertically scrolling regions could not be reached or scrolled by keyboard |
| A11Y8-006 | 4.1.2 Name, Role, Value (`button-name`) | critical | Fixed | form builder "Versions", workflow designer "Versions" (390 px) | Below `sm` the label is hidden, which left an icon-only button with no accessible name |
| A11Y8-005 | 1.4.3 Contrast (`color-contrast`) | serious | Fixed | platform plan editor, limits of features not in the plan | The whole row was `opacity-60`, so labels and values fell to 4.24:1 |
| A11Y8-007 | 2.5.8 Target Size (Minimum) | serious | Fixed | report builder field tree "+" (add field) | The target rendered at 21 × 21 px (`size-6` at the 14 px root font) |
| A11Y8-008 | 2.4.7 Focus Visible | serious | Fixed | compact (grid) comboboxes | Only a border-colour change. Now a 1 px inset ring as well, matching the grid's text cells |

Each fix:
- **001:** `DialogContent` and `SheetContent` mount a tiny `Remember` child that records `document.activeElement`
  during render, before Radix's focus scope moves focus. `onCloseAutoFocus` then focuses it if it is still in the
  DOM. A caller's own `onCloseAutoFocus` still runs first and can `preventDefault()`.
- **002:** `inputClass` adds `[&[type^=date]:focus]` and `[&[type=time]:focus]` outline rules.
- **003:** each scroll container gets `tabIndex={0}` and a `focus-visible` ring.
- **004 / 008:** `focus-within:` outline on the combobox wrapper.
- **005:** only the non-text Switch is dimmed. Labels, descriptions and the value keep full contrast, and the row
  still says "requires <feature>".
- **006:** `aria-label` on the "Versions" buttons.
- **007:** `size-7`.

## Verified, no finding
- **Landmarks:** a skip link ("Skip to content" → `#main`) exists, followed by `<nav aria-label>`, `<header>` and
  `<main id="main" tabIndex=-1>`. The first Tab stop after sign-in is the skip link only when the page is fresh.
  After a client navigation the first stop is the sidebar's "Dashboard" link, because focus stays in the shell; this
  is acceptable.
- **Dialogs:** `role="dialog"`, `aria-modal`, a title (`aria-labelledby`) and a description (an sr-only fallback).
  Tab and Shift+Tab stay inside; Escape closes. Initial focus lands on the first focusable element, the close button.
- **Forms:**
  - every form-renderer control has a label (`id`/`htmlFor`, or `aria-label` in grids);
  - errors are linked by `aria-describedby`, with `aria-invalid`;
  - the error summary is shown at the top ("Fix N highlighted fields").
- **Approval screen:** the per-line Approve/Hold/Reject buttons are `aria-pressed` toggles, with documented keyboard
  shortcuts (`aria-keyshortcuts`). Enter submits.
- **Contrast:** apart from A11Y8-005, there were no contrast violations in the light theme on any scanned route. The
  dark theme was not scanned; that is a recommendation for the next pass.

## Not covered / recommendations
- Screen-reader smoke tests (NVDA/VoiceOver) were not possible in this sandbox. axe and the keyboard walkthrough
  cover the automatable part.
- Dark theme (`data-theme="dark"`) contrast: run the same sweep with the theme toggled.
- Drag-and-drop in the form builder and workflow designer was not assessed for keyboard alternatives in this pass.
  axe passed on both screens; Phase 2/3 a11y specs cover the designer panels.
- Charts (dashboards, report viewer) were only checked by axe, which cannot judge whether an SVG chart has an
  adequate text alternative. Recommend a manual WCAG 1.1.1 review and a "view as table" option on dashboard widgets.

## Files changed
- `packages/ui/src/components/dialog.tsx`, `packages/ui/src/components/input.tsx`, `packages/ui/src/components/data-table.tsx`
- `apps/web/src/engines/form-renderer/combobox.tsx`, `apps/web/src/features/documents/lines-table.tsx`,
  `apps/web/src/features/reports/results-table.tsx`, `apps/web/src/features/reports/builder/field-tree.tsx`,
  `apps/web/src/features/platform/plan-editor.tsx`, `apps/web/src/engines/form-builder/builder-page.tsx`,
  `apps/web/src/features/workflows/designer-page.tsx`
- `e2e/a11y-phase8.spec.ts` (new)
