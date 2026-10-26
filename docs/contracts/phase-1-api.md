# Phase 1 API contract (FROZEN)

Base: `/api/v1`. JSON bodies. Errors are RFC 7807 `application/problem+json` with stable `code` (see `packages/schema/src/common.ts`).
Request/response types are in `@procure/schema` (`platform.ts`, `identity.ts`, `common.ts`). Changes need an ADR + Architect approval.

## Auth (both audiences)

| Method | Path | Body | Response | Notes |
| --- | --- | --- | --- | --- |
| POST | `/auth/login` | `TenantLogin` | `AuthResult` + sets `rt` cookie | Public. Lockout after `security.max_failed_logins` (tenant setting, default 5) for `security.lockout_minutes`. Same error for wrong email/password/tenant: `AUTH.INVALID_CREDENTIALS`. Locked: **423** `AUTH.ACCOUNT_LOCKED` with `meta.lockedUntil`. |
| POST | `/auth/platform/login` | `PlatformLogin` | `AuthResult` + `rt` cookie | Public. Super Admin team. Lockout 5 / 15 min (**423** `AUTH.ACCOUNT_LOCKED`). |
| POST | `/auth/refresh` | – (cookie `rt`) | `AuthResult` + rotated cookie | Public. Rotation; reusing an already-rotated token revokes the whole family → `AUTH.REFRESH_REUSED` (401). |
| POST | `/auth/logout` | – | 204 | Revokes current session (refresh + immediate access revocation via Redis). |
| GET | `/auth/me` | – | `{ principal, mustChangePassword, features: string[], limits?: Entitlements['limits'] }` | `@AllowPendingPassword`. For tenant users `features` = effective plan features (UI hides modules not in plan). |
| POST | `/auth/password/change` | `PasswordChange` | `AuthResult` | `@AllowPendingPassword`. Clears `must_change_password`, revokes other sessions. |
| GET | `/auth/sessions` | – | `SessionRow[]` | Own sessions. |
| DELETE | `/auth/sessions/:id` | – | 204 | Revoke own session. |

Cookie `rt`: httpOnly, `SameSite=Strict`, `Secure` in prod, path `/api/v1/auth`, lifetime `security.session_days` (default 30).
Access token: JWT HS256, 15 min, claims `AccessClaims`. Client keeps it in memory only.
`AuthResult.mustChangePassword = true` → every route except `/auth/me`, `/auth/password/change`, `/auth/logout` returns 403 `AUTH.PASSWORD_CHANGE_REQUIRED`.

## Platform (Super Admin, `@PlatformOnly`)

| Method | Path | Body / Query | Response |
| --- | --- | --- | --- |
| GET | `/platform/catalog` | – | `{ features: FeatureCatalogRow[], limits: LimitCatalogRow[] }` |
| GET | `/platform/plans` | – | `Plan[]` |
| POST | `/platform/plans` | `PlanInput` | `Plan` (owner, billing) |
| PUT | `/platform/plans/:id` | `PlanInput & { version }` | `Plan` (owner, billing). Invalidates entitlement cache for every tenant on the plan. |
| GET | `/platform/tenants` | `ListQuery & { status? }` | `Page<TenantListRow>` — `TenantListRow = { id, code, name, status, planName, subscriptionStatus, renewalDate, activeUsers, maxUsers, createdAt }` |
| POST | `/platform/tenants` | `TenantCreate` | `TenantCreated` (owner, support). One transaction: tenant + subscription + system role `tenant_admin` + admin user (`must_change_password=true`, random 16-char temp password) + copied `templateBundle` if given. |
| GET | `/platform/tenants/:id` | – | `{ tenant, subscription, entitlements: Entitlements }` |
| PUT | `/platform/tenants/:id` | `TenantUpdate` | tenant |
| POST | `/platform/tenants/:id/suspend` \| `/reactivate` \| `/archive` | `TenantStatusChange` | tenant. Suspend/archive revokes all tenant sessions. |
| PUT | `/platform/tenants/:id/overrides` | `OverrideSet` | `Entitlements`. Writes `tenant_override_history`. |
| GET | `/platform/tenants/:id/overrides/history` | – | history rows newest first |
| POST | `/platform/tenants/:id/subscription` | `SubscriptionChange` | subscription. Closes current row, opens new one. |
| GET | `/platform/tenants/:id/subscriptions` | – | subscription history |
| POST | `/platform/tenants/:id/admin/reset-password` | – | `{ temporaryPassword }` |
| POST | `/platform/tenants/:id/impersonate` | `{ reason }` | `AuthResult` for the tenant admin with `impersonatedBy` set. Audited on both platform and tenant logs. |
| GET | `/platform/usage` | – | `{ tenantId, code, name, limits: { key, used, effective }[] }[]` |
| GET | `/platform/audit` | `ListQuery & { tenantId? }` | `Page<PlatformAuditRow>` |

## Tenant identity (`@TenantOnly`; admin-only routes marked)

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/users` | `ListQuery & { active? }` | `Page<UserRow>` (admin) |
| POST | `/users` | `UserCreate` | `{ user: UserRow, temporaryPassword }` (admin). **Enforces `max_users`** via `app.lock_tenant_for_limit('max_users')` + live count of active users → `LIMIT_EXCEEDED.max_users` (403) with clear message. Emits 80%/100% warning notifications to tenant admins. |
| GET | `/users/:id` | – | `UserRow` (admin) |
| PUT | `/users/:id` | `UserUpdate` | `UserRow` (admin) |
| POST | `/users/:id/deactivate` | – | `UserRow` (admin). Revokes sessions. |
| POST | `/users/:id/activate` | – | `UserRow` (admin). Counts against `max_users`. |
| POST | `/users/:id/reset-password` | – | `{ temporaryPassword }` (admin) |
| POST | `/users/:id/unlock` | – | `UserRow` (admin) |
| GET | `/users/:id/sessions` | – | `SessionRow[]` (admin) |
| POST | `/users/:id/force-logout` | – | 204 (admin) |
| GET | `/roles` | – | roles (admin) |
| POST | `/roles` | `RoleInput` | role (admin) |
| GET | `/notifications` | `ListQuery & { unread? }` | `Page<Notification>` |
| POST | `/notifications/:id/read` | – | 204 |
| GET | `/tenant/usage` | – | `Entitlements` (admin) — same shape the Super Admin sees for this tenant |

## Rules every handler follows
- Tenant data only through `DbService.tenantTx(principal.tenantId, tx => …)`. Never `platformTx` in tenant-facing modules (except identity/auth for login + the limit/entitlement helpers already in SQL).
- Every mutation calls `AuditService.tenant(tx, …)` / `.platform(tx, …)` in the same transaction.
- Writes with `version` in the body use `where version = :v`; zero rows updated → `AppError.versionConflict()`.
- After changing plans/overrides/subscriptions/tenant status → `EntitlementsService.invalidate(tenantId)`; after user changes → `invalidatePrincipal()`.
