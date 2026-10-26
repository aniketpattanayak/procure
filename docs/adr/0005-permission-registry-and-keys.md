# ADR-0005 Permission registry, key grammar and enforcement seam

Status: accepted (Phase 2)

- Keys: tab `<tab>`, action `<tab>:action.<name>`, view `<tab>:view.<name>`. A tab is visible iff
  `<tab>:action.view` is held. Helpers in `@procure/schema` (`perm.*`) build keys.
- Registry = `platform.permission_def` (shipped surfaces, migration-seeded) ∪ `app.permission_def` (generated per
  tenant from masters now, workflow stages/custom forms later). Each entry may require a plan feature and/or a
  boolean flow setting; entries failing either are invisible on the permission screen and never effective.
- Effective = registry-visible ∩ ((∪ role grants ∪ user allow) − user deny). Tenant admins: every visible key.
- Field access lives in `app.field_access` (not in the form JSON as the design pack sketched) so the permission
  screen owns it and form publishes don't churn permission data. Roles: most restrictive wins; user row overrides.
- Data scope rows `app.scope_grant` (role or user, optional tab) resolve to ltree paths; queries filter with
  `path <@ ANY(paths)`.
- Core's AuthGuard enforces `@Requires/@RequiresAny` through the `PERMISSION_RESOLVER` provider, failing closed if
  none is registered; handlers with runtime keys use `hasPermission`. Cache key includes a per-tenant `permver`
  bumped on every input change.
