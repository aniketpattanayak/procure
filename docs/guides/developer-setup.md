# Developer setup

How to get the procure monorepo running on your machine: API (NestJS) on `:4000`, web (Next.js) on `:3000`,
PostgreSQL 16 and Redis 7.

## 1. Prerequisites

| Tool              | Version | Notes                                                                                                                           |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Node.js           | 22.x    | `node -v`. Use nvm/fnm/volta if you juggle versions.                                                                            |
| pnpm              | 10.28.0 | `corepack enable && corepack prepare pnpm@10.28.0 --activate`. The version is pinned in root `package.json` (`packageManager`). |
| PostgreSQL        | 16      | Local install or Docker. The migrator connects as `postgres` with no password (trust auth on localhost).                        |
| Redis             | 7       | Local install or Docker.                                                                                                        |
| Docker (optional) | 24+     | Only for the full-stack compose file or for building images.                                                                    |

No local Postgres or Redis? Start just those two from the compose file. It maps them to host ports **5433**
and **6380**, so set these in `.env`:

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis
# .env:
# DATABASE_URL=postgres://app_user:app_pass@localhost:5433/procure
# DATABASE_MIGRATOR_URL=postgres://postgres:postgres@localhost:5433/procure
# DATABASE_PLATFORM_URL=postgres://platform_user:platform_pass@localhost:5433/procure
# REDIS_URL=redis://localhost:6380
```

## 2. Install

```bash
git clone <repo> procure && cd procure
cp .env.example .env          # dev-only values; never put real secrets in .env.example
pnpm install
```

## 3. Database

```bash
pnpm db:reset      # drop + recreate the `procure` database and apply every migration (dev only!)
pnpm db:migrate    # apply only new migrations (what CI and deploys run)
pnpm lint:rls      # check every app.* table has tenant_id + FORCE RLS + tenant policy
```

The database model (ADR-0002):

- `postgres` / migrator: owns all objects and runs migrations. Never used by the running app.
- `app_user` (NOBYPASSRLS): all tenant traffic. It only sees rows for `app.current_tenant_id()`, which
  `DbService.tenantTx()` sets per transaction.
- `platform_user` (BYPASSRLS): Super Admin and auth only, through `DbService.platformTx()` / `db.platform`.
  Lint only allows these in `modules/platform`, `modules/identity`, `core` and `seed`.

Migrations in `db/migrations/*.sql` are forward-only and checksummed. Never edit an applied migration;
add a new one. Every new tenant table needs:

```sql
CREATE TABLE app.thing (
  id        uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  tenant_id uuid NOT NULL DEFAULT app.current_tenant_id(),
  ...
);
SELECT app.enable_tenant_rls('app.thing');
```

`pnpm lint:rls` fails if you forget. In the rare case a table in `app` is genuinely tenant-agnostic, add
`{"table": "app.thing", "reason": "..."}` to `db/policies/rls-allowlist.json`. Expect review pushback:
tenant-agnostic tables normally belong in `platform`.

## 4. Seed demo data

```bash
pnpm build         # the seed runs from apps/api/dist
pnpm db:seed
```

## 5. Run

```bash
pnpm dev                              # everything (turbo, parallel)
pnpm --filter @procure/api dev        # API only  -> http://localhost:4000/health, /api/v1/...
pnpm --filter @procure/web dev        # web only  -> http://localhost:3000
```

Full stack in containers (postgres, redis, migrate job, api, web):

```bash
pnpm docker:up       # docker compose -f infra/docker-compose.yml up --build -d
pnpm docker:down
```

## 6. Tests and checks

```bash
pnpm test            # unit + integration (vitest). API tests recreate `procure_test` and use Redis db 1.
pnpm e2e             # Playwright; needs api + web running and seeded (pnpm exec playwright install chromium once)
pnpm lint            # ESLint for the whole repo (module boundaries, platform-DB guard, no eval)
pnpm lint:fix
pnpm format          # Prettier write; `pnpm format:check` in CI-style mode
pnpm typecheck
pnpm build
pnpm lint:rls        # RLS policy lint against DATABASE_MIGRATOR_URL
```

CI (`.github/workflows/ci.yml`) runs the same commands: migrate, lint:rls, lint, typecheck, build,
test, then E2E, dependency audit, Trivy and gitleaks. Run them locally before pushing.

### Lint rules that matter

- **Module boundaries:** a file in `apps/api/src/modules/<a>` may import module `<b>` only via
  `../<b>` (its `index.ts`). Deep imports such as `../b/b.service` fail. Export what other modules need
  from `index.ts`.
- **Platform DB guard:** `platformTx`, `platformDb` and `db.platform` / `this.db.platform` are errors
  outside `modules/platform`, `modules/identity`, `core` and `seed`. Use `db.tenantTx(tenantId, tx => ...)`.
- **No dynamic code:** `eval`, `new Function`, `Function()` and string `setTimeout` are banned.

## 7. Troubleshooting

| Symptom                                      | Fix                                                                                           |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `Migration X was edited after being applied` | You changed an applied migration. Revert it and add a new file; in dev only, `pnpm db:reset`. |
| Queries return zero rows                     | No tenant context. Use `db.tenantTx(tenantId, ...)`; RLS fails closed.                        |
| `new row violates row-level security policy` | Insert/update has a `tenant_id` different from the context tenant.                            |
| `ERR_PNPM_...lock` during install            | Another install is running; wait and retry.                                                   |
| Port 5432/6379 busy when using compose       | Compose uses 5433/6380 on the host; point `.env` at those.                                    |
