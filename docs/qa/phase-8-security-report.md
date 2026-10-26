# Phase 8 security report — OWASP ASVS L2 review of API, web and dependencies

Date: 2026-10-23. Environment: local sandbox (Node 22, Postgres 16, Redis :6380, Chromium 141 headless). The machine
(2 vCPU, 7 GB) is shared with the Phase 3 and Phase 5 bug fixers and the infra agent.

Scope:
- `apps/api/src/**` (NestJS);
- `apps/web/src/**` (Next.js);
- `packages/*`;
- `db/migrations`;
- the git history;
- the pnpm dependency tree.

**Result: no tenant-isolation or authorisation defect was found.** The route-table sweeps confirmed each of the following:
- every non-public route requires a token;
- the platform and tenant audiences are fully separated;
- a tenant admin holding all 20 of another tenant's real ids, across all 129 id-taking routes (2,580 requests),
  got no data back, changed nothing and caused no 5xx.

The serious issues were:
- a critical template-injection CVE set in the Handlebars version, reachable by tenant template authors;
- a single-request process hang through the upload type sniffer;
- a ReDoS through form-designer patterns;
- a stored XSS in the template preview;
- a web app that sent no security headers at all.

**16 findings: 1 critical, 2 high, 3 medium, 6 low and 4 informational.** 11 were fixed with regression tests or
checks in this review; the polish round (end of this report) fixed SEC8-015 and SEC8-016 and part of SEC8-013. Now 13
are fixed, 1 is accepted by design (SEC8-014) and 2 are open (SEC8-012 build output in git, SEC8-013 the remaining
dependency majors, mitigated). None of the open ones is critical.

## How it was run
- Isolated environment: `export AGENT_REDIS_PORT=6380; source scripts/agent-env.sh sec 6 4120 3120`.
  - The shared `apps/api/dist` was stale and is shared, so the API was compiled from the working tree into
    `apps/api/.dist-sec` (git-ignored by `.dist-*/`): `tsc -p tsconfig.build.json --outDir .dist-sec`.
  - It was then seeded with `.dist-sec/seed/demo.js` and run on :4120. Web: `next dev --turbopack` on :3120 (`NEXT_DIST_DIR=.next-sec`).
- DAST: `apps/api/test/sec-phase8.test.ts` (vitest + supertest, in-process, from source). OWASP ZAP was not available
  (no Docker image pulls, no `zap.sh`), so the suite is a scripted DAST.
  - Its authN/authZ sweeps are **generated from the live Express route table** (244 routes), so a new controller is covered automatically.
  - Run: `cd apps/api && pnpm test test/sec-phase8.test.ts`. 50 tests, about 25 s.
- Regression after the fixes: 12 suites covering files, templates (API + PDF), form validators, auth, platform, notify
  channels/webhooks/units, QA2 security, audit and record import. 273 tests, all green.

### Tools
| Tool | Status | Notes |
|---|---|---|
| `pnpm audit --prod` / full | ran | 63 prod advisories (4 critical, 25 high) before, 31 (0 critical, 11 high) after |
| semgrep 1.x (pipx) | ran | semgrep.dev registry is blocked by the proxy; ran the GitHub `semgrep-rules` JavaScript, TypeScript and generic/secrets packs (425 rules, local) over apps/packages/db/scripts. Triage below |
| gitleaks 8.21.2 | ran | over the whole git history (46 commits) and the working tree |
| OWASP ZAP | not available | replaced by the scripted DAST |
| trufflehog | not installed | gitleaks covered it |
| axe-core | see `phase-8-a11y-report.md` | |

## Findings

| Id | Severity | Status | Summary |
|---|---|---|---|
| SEC8-001 | Critical | Fixed | handlebars 4.7.8: AST type confusion / own-property bypass → JS injection (4 critical/high CVEs). Tenant users with the templates permission author templates, so this is reachable server-side RCE across tenants |
| SEC8-002 | High | Fixed | file-type 16.5.4 ASF parser loops forever. A 200-byte upload by any tenant user freezes the API event loop (all tenants) |
| SEC8-003 | High | Fixed | ReDoS: form-designer `regex` patterns run on the API against up to 10,000 chars. `(a+)+b` with 32+ chars blocks the event loop |
| SEC8-004 | Medium | Fixed | Stored XSS: template header/footer HTML was injected into the app DOM with a bypassable regex "strip scripts" |
| SEC8-010 | Medium | Fixed (residual) | Web app sent no CSP, X-Frame-Options or Referrer-Policy (clickjacking, no XSS defence in depth) |
| SEC8-013 | Medium | Open (mitigated; partly fixed) | Remaining dependency advisories need major upgrades. Polish round: nodemailer 6 → 10, sharp 0.34 → 0.35 (API and Next), csv-parse 5 → 7 upgraded; kysely, file-type, @nestjs/core and transitive fast-xml-parser/uuid/@smithy remain |
| SEC8-005 | Low | Fixed | Impersonation access tokens stayed valid after the platform user was deactivated (refresh checked it, requests did not) |
| SEC8-006 | Low | Fixed | AES-256-GCM decrypt accepted truncated auth tags (no `authTagLength`) |
| SEC8-007 | Low | Fixed | `platform.audit_log` was UPDATE/DELETE-able by `platform_user` (the tenant log is append-only) |
| SEC8-008 | Low | Fixed | Client `X-Request-Id` flowed unvalidated (any length/content) into request context, logs and audit |
| SEC8-011 | Low | Fixed | URL-field values were rendered straight into `href` (server validates http/https; no client guard) |
| SEC8-012 | Low | Open | A Next build dir (`apps/web/.next-fix3`, 1,530 files) is committed, including preview-mode signing/encryption keys |
| SEC8-009 | Info | Fixed | The principal cache key omitted the tenant id, so a token naming another tenant was answered from cache (not exploitable without the JWT key) |
| SEC8-014 | Info | Accepted | Any tenant user (even with no role) can list colleagues (`/users/options`: name, email) and master options. This is by design for lookups and mentions |
| SEC8-015 | Info | Fixed | The audit hash chain was plain SHA-256: an attacker with DB write access could recompute it. Now HMAC-SHA256 with `AUDIT_HASH_KEY` (outside the DB), per-row algorithm marker (migration 0022), no-downgrade verification, key rotation |
| SEC8-016 | Info | Fixed | Web CSP needed `script-src 'unsafe-inline'`; `sharp` kept its default 268 MP input-pixel limit. Now a per-request nonce CSP (Next middleware, `'strict-dynamic'`, no `'unsafe-inline'` for scripts) and an explicit 50 MP `limitInputPixels` |

### SEC8-001 — handlebars critical CVEs (fixed)
- **Repro:** `pnpm audit` lists GHSA advisories for handlebars ≤ 4.7.9. These include "JavaScript Injection via AST Type
  Confusion", its bypass, and "Own Property Check Bypass".
- **Exposure:** templates are compiled from tenant-authored source (`TemplateEngine.compile`). The sandbox
  (`knownHelpersOnly`, prototype access off, vm watchdog) does not protect against compiler-level injection.
- **Fix:** `apps/api/package.json` handlebars `4.7.8 → 4.7.10` (patch).
- **Other patch/minor bumps,** as `pnpm-workspace.yaml` `overrides`:
  - multer `^2.5.0` (6 DoS advisories);
  - fast-xml-parser 4.x `^4.5.7` (critical entity bypass, under the AWS SDK);
  - qs `^6.16.1`;
  - body-parser `^1.20.9`;
  - postcss `^8.5.31`.
- **Verification:** templates API and PDF suites are green. Prod critical advisories went from 4 to 0.

### SEC8-002 — upload type sniffing hangs the process (fixed)
- **Repro:** a 200-byte buffer: the ASF GUID followed by a sub-object of size 0, uploaded as `clip.png`.
  - `fromBuffer` calls `tokenizer.ignore(-24)` and loops forever in microtasks, so even timers stop.
  - Confirmed standalone: a 10 s `timeout` killed it.
- **Fix:** `apps/api/src/modules/files/sniff.ts` refuses the ASF magic before `file-type` sees the bytes. ASF is never
  allowed anyway. Upgrading file-type needs v21 (ESM-only), which is tracked in SEC8-013.
- **Test:** `[SEC8-002]` uploads the bytes and expects 400 in < 5 s.

### SEC8-003 — ReDoS in form patterns (fixed)
- **Repro:** a master with a field `{ type: 'regex', pattern: '(a+)+b' }`, then POST a record with
  `ref = 'a' × 40 + '!'`. Measured: 25 chars take 151 ms, and every extra char doubles the time.
- **Fix:** `forms/validators.ts` `boundedTest()` runs the test in a `vm` context with a 50 ms limit (V8 interrupts the
  backtracking). A timeout gives the field error "… pattern is too complex". The web form renderer still runs patterns
  client-side; that is self-DoS only.
- **Test:** `[SEC8-003]` expects 400 in < 3 s, and a normal value is still accepted.

### SEC8-004 — stored XSS in the template editor preview (fixed)
- `features/templates/previews.tsx` rendered `pdfOptions.headerHtml/footerHtml` with `dangerouslySetInnerHTML` after
  a regex filter. `<img src=x/onerror=alert(1)>` (no whitespace before `on`) passed it.
- A user with the templates permission could therefore run script in the session of an admin who opened the template.
- **Fix:** the bands render in `sandbox=""` iframes (no scripts, opaque origin), like the body preview already did.
  `stripScripts` was removed.

### SEC8-010 — web security headers (fixed, residual risk)
- `apps/web/next.config.ts` now sends the following on every route:
  - CSP: `default-src 'self'`; API origin for connect/img; `object-src 'none'`; `base-uri 'self'`;
    `form-action 'self'`; `frame-ancestors 'none'`;
  - `X-Frame-Options: DENY`, nosniff, `Referrer-Policy: strict-origin-when-cross-origin`, Permissions-Policy and COOP;
  - HSTS in production.
- Verified on the dev server, and the a11y run navigated every main route under it.
- **Residual (fixed by SEC8-016 in the polish round):** `script-src 'unsafe-inline'`, plus `'unsafe-eval'` and `ws:` in dev only. Next's app router inlines its
  RSC payload, so a nonce middleware is needed to drop `'unsafe-inline'`. The production build was not exercised here
  (`next build` OOMs on this machine); a CI e2e run on the standalone build should confirm it.
- The API already had helmet. The test asserts HSTS, `frame-ancestors`, nosniff, `no-referrer`, no `X-Powered-By`,
  and the CORS allow-list with credentials.

### SEC8-013 — dependency advisories left (open, mitigated)
`pnpm audit --prod` after the fixes: 31 (0 critical, 11 high, 18 moderate, 2 low). Each one needs a major or 0.x-minor
upgrade. **Polish round:** nodemailer, sharp and csv-parse are upgraded (rows marked below); `pnpm audit --prod` is now
11 (0 critical, 3 high, 7 moderate, 1 low), all in the packages still listed as open:

| Package | Now → fixed | Why not upgraded here / mitigation |
|---|---|---|
| nodemailer | 6.9.16 → ≥10.0.10 | **Upgraded to 10.0.16 (polish round).** Before: 4 majors. Addressparser DoS and domain-confusion CVEs need attacker-controlled recipient strings; recipients pass a strict email regex first (`notify/util/address.ts`). The `raw` / file / URL access options are never used. SMTP settings are platform-only. Plan the upgrade with the email channel owner |
| kysely | 0.27.6 → ≥0.28.17 | 0.x minor with breaking changes. The vulnerable APIs (`JSONPathBuilder.key()/.at()`, string `sql.lit`, MySQL dialect) are not used: `sql.lit` only takes numbers/booleans (checked) and JSON paths are parameterised `->>${key}`. Upgrade with the next DB-layer change |
| sharp | 0.34.4 → ≥0.35.5 | **Upgraded to 0.35.5 (polish round)**, in the API and, via the `next>sharp` override, Next's optional copy (the app does not use `next/image`). Before: libvips/libheif/librsvg CVEs; native rebuild. Only PNG/JPEG/WebP/GIF bytes reach sharp (magic-byte sniff); SVG/HEIF are refused before it |
| file-type | 16.5.4 → ≥21.3.1 | ESM-only major. ASF loop blocked (SEC8-002); ZIP-bomb advisory only affects ≥20 (Nest's internal copy, unused: no `FileTypeValidator`) |
| @nestjs/core | 10.4 → 11.1.18 | Major. Moderate injection advisory concerns a downstream renderer not used |
| fast-xml-parser | 4.5.7 → 5.7 | XMLBuilder comment/CDATA issue; the AWS SDK only parses S3/SES responses |
| uuid (aws-sdk, exceljs) | 9/8 → 11 | `buf` argument never passed |
| csv-parse | 5.6 → 7 | **Upgraded to 7.0.3 (polish round).** The `columns` path was not used anyway (`parseCsv` without `columns`) |
| dev only: vitest/tinypool/vite/esbuild | majors | Test runner/dev server only; the Vitest UI server is never started. Upgrade vitest 2 → 4 with the test-infra owner |

### SEC8-005 / 006 / 007 / 008 / 009 / 011 (fixed)
- **005:** `core/auth/auth.guard.ts` `loadPrincipal` returns null when the impersonating platform user is missing or
  inactive. Test `[SEC8-005]`.
- **006:** `notify/util/crypto.ts` decrypts with `{ authTagLength: 16 }`.
- **007:** migration `db/migrations/0021_sec8_platform_audit_append_only.sql` revokes UPDATE/DELETE/TRUNCATE on
  `platform.audit_log` from `platform_user`. No code path needs them. Test `[SEC8-007]` checks both roles against both logs.
- **008:** `bootstrap.ts` keeps `X-Request-Id` only if it matches `[A-Za-z0-9._:-]{1,128}`, and otherwise generates a UUID.
  Test `[SEC8-008]`.
- **009:** the principal cache key now includes the tenant id. Test `[SEC8-009]`.
- **011:** `engines/form-renderer/controls.tsx` renders URL-field values as links only for `http(s)://`.

### SEC8-012 — build output in git (open)
- `git ls-files apps/web/.next-fix3 | wc -l` returns 1530. They were committed in `76f1ed5`, before `.gitignore` gained
  `.next-*/`.
- gitleaks flags `previewModeSigningKey` / `previewModeEncryptionKey` in `prerender-manifest.json` and `.previewinfo`.
- These keys are per build and only protect Next draft/preview mode, which the app does not use. Low impact, but they
  are build artefacts in history.
- **Remediation** (not done, since commits are out of scope for this pass):
  - `git rm -r --cached apps/web/.next-fix3`, then commit;
  - production builds generate fresh keys;
  - optionally purge the history.
- No other secrets in the history or working tree. `.env` is untracked and holds dev values only.

### Verified controls (no finding)
- **AuthN:**
  - forged tokens get 401: `alg: none`, wrong secret, HS512, expired, garbage, tampered payload;
  - a `tid` spoof or a `typ: platform` token for a tenant user finds no principal;
  - logout kills the access token at once;
  - a reused rotated refresh token revokes the family;
  - the refresh cookie is `HttpOnly; SameSite=Strict; Path=/api/v1/auth`;
  - impersonation sessions expire in ≤ 60 min;
  - lockout and rate limits are already covered by `auth.test.ts` / `rate-limit.test.ts`.
- **AuthZ (generated from the route table):**
  - unauthenticated: exactly the 8 documented public routes answer anything but the guard's 401;
  - a platform token is refused on every tenant route;
  - a tenant admin is refused on every platform route;
  - cross-tenant IDOR sweep as above;
  - a user with no roles gets 403/404 everywhere except self-service and the by-design lookup feeds (SEC8-014).
- **RLS:**
  - there is no tenant header: the tenant comes only from the signed token;
  - cross-tenant writes changed none of A's rows (md5 of every tenant-scoped table before and after).
- **Injection:**
  - SQL metacharacters in list `q`, `sort`, `status`, `cursor`, filters, masters, users, audit, inbox, stock: no 5xx,
    no DB error text, no `pg_sleep` delay;
  - report definitions with injected field ids, sources, aggregates, sort directions and filter values are refused by
    zod or parameterised. Every `sql.raw` is a constant or an allow-listed value;
  - Handlebars prototype/constructor payloads produce no code execution;
  - formula-engine escapes are covered by QA2.
- **CSV/XLSX formula injection:**
  - CSV cells starting with `= + - @` (plus tab/CR) are prefixed with `'`;
  - XLSX cells are written as strings, and the test checks the workbook holds 0 formula cells.
- **SSRF:**
  - 21 webhook URLs are refused: http, loopback, decimal/hex/octal IPv4, IPv6 loopback/mapped/NAT64/6to4, metadata
    v4/v6, RFC 1918, CGNAT, `localhost`, `*.internal`, credentials in the URL, `file:` and `gopher:`;
  - DNS answers mixing public and private addresses are refused;
  - the vetted address is the one dialled (pinned `lookup`), which defeats rebinding;
  - redirects are not followed (raw `https.request`; SNS fetches use `redirect: 'error'`);
  - the PDF renderer has JS off and a route lock that aborts everything but the page and signed file URLs
    (`templates/pdf.renderer.ts`, tested in `templates.pdf.test.ts`).
- **Uploads:**
  - magic-byte sniffing with an extension match;
  - 25 MB limit (413);
  - traversal in names neutralised;
  - SVG/HTML/polyglots refused or served as attachments with nosniff (QA2);
  - signed URLs reject tampering, expiry and other tenants (QA2).
- **Mass assignment:** forged `id`, `tenant_id`, `status_key`, `number` and `created_by` on document create, and
  `isTenantAdmin` / `tenantId` / `passwordHash` on user update, are all ignored.
- **Error leakage:**
  - malformed JSON gives 400 and a > 1 MB body gives 413;
  - bad ids and unknown routes leak no stack, SQL or paths;
  - 500s say "Something went wrong on our side".
- **Secrets at rest:**
  - passwords are argon2id;
  - refresh tokens are stored as sha256 only;
  - webhook and provider secrets are AES-256-GCM (`v1:` blobs), and a webhook secret is shown once.
- **Audit:** the tenant log is append-only for both roles, and verification detects an edited row (test). See
  SEC8-015 for the keyed-hash recommendation.

### semgrep triage (425 local rules, 2,159 hits)
- Noise:
  - 1,855 `i18next-key-format`;
  - 141 `react-props-spreading`;
  - 111 `missing-template-string-indicator`;
  - 15 `no-stringify-keys`.
- Security-relevant hits, reviewed:
  - `detect-non-literal-regexp` in `forms/validators.ts:160` became **SEC8-003**. The `structure.ts` and web hits
    only compile a pattern or run it client-side;
  - `gcm-no-tag-length` became **SEC8-006**;
  - `html-in-template-string` (exports, table-pdf, templates): every interpolation is `esc()`-ed;
  - `res-render-injection` (templates.service): a false positive (Handlebars `render`, sandboxed);
  - `prototype-pollution-loop` (`notify/renderer.ts` `lookupPath`): own properties only;
  - `detect-redos` on static regexes (email/event-name): all anchored, with no nested quantifiers;
  - `unsafe-dynamic-method` (entitlements counters): a fixed map.

## Files changed
- `apps/api/package.json`, `pnpm-workspace.yaml` (overrides), `pnpm-lock.yaml`
- `apps/api/src/modules/files/sniff.ts`, `apps/api/src/modules/forms/validators.ts`, `apps/api/src/modules/notify/util/crypto.ts`
- `apps/api/src/core/auth/auth.guard.ts`, `apps/api/src/bootstrap.ts`
- `db/migrations/0021_sec8_platform_audit_append_only.sql`
- `apps/web/next.config.ts`, `apps/web/src/features/templates/previews.tsx`, `apps/web/src/engines/form-renderer/controls.tsx`
- `apps/api/test/sec-phase8.test.ts` (new)

## Polish round (2026-10-23)

Isolated slot `export AGENT_REDIS_PORT=6380; source scripts/agent-env.sh polish 8 4122 3122`; API compiled into
`apps/api/.dist-polish`, web `next dev --turbopack` with `NEXT_DIST_DIR=.next-polish` (both git-ignored).

### SEC8-015 — keyed audit hash chain (fixed)
- **Migration `0022_sec8_audit_hmac.sql`:** `hash_alg text NOT NULL DEFAULT 'sha256'` with a check
  (`'sha256' | 'hmac-sha256'`) on `app.audit_log` and `platform.audit_log`. Adding a column with a constant default is
  metadata-only: no UPDATE runs on the append-only tables, and every existing row reads back as `'sha256'`.
- **Writing:** `AuditService` (tenant and platform) and the demo seed hash new rows with HMAC-SHA256 under
  `AUDIT_HASH_KEY` (message prefixed `hmac-sha256|`, then the same canonical row as before) and store
  `hash_alg = 'hmac-sha256'`. `core/audit.service.ts` `chainHash(prev, row, jsonParsed, alg, key)`.
- **Verifying** (`AuditVerifier.verifyChain`):
  - `sha256` rows are checked with the plain hash, **but only before the chain's first keyed row**. A plain row after a keyed
    one fails with "unkeyed hash after keyed rows". This blocks the downgrade where a DB writer appends or rewrites rows
    with recomputable SHA-256;
  - `hmac-sha256` rows are checked against `AUDIT_HASH_KEY` and every key in `AUDIT_HASH_KEY_PREVIOUS` (rotation);
  - an unknown marker fails.
- **Config:** `AUDIT_HASH_KEY` (min 32 chars) is required under `NODE_ENV=production`, the same as `FILE_URL_SECRET`. Dev and
  test derive it from `JWT_SECRET`. `AUDIT_HASH_KEY_PREVIOUS` is an optional comma-separated list. Wired like
  `FILE_URL_SECRET`/`PROVIDER_KEY`:
  - Terraform `random_id.audit_hash_key`, secrets `audit_hash_key` and `audit_hash_key_previous` (seeded equal), ECS
    `secrets` for api and worker;
  - `infra/docker-compose.yml` dev value;
  - `.env.example`;
  - `docs/guide/runbook.md` (env table, secrets/rotation table, audit-chain playbook messages).
- **Residual:** with both the database and the key, an attacker can still recompute the chain. So can someone who
  rewrites a whole chain back to `sha256` from its first row. External anchoring (periodically exporting the chain head
  outside the account) would close both, and is not done.
- **Test:** `[SEC8-015]` in `sec-phase8.test.ts` checks four things:
  - new rows are keyed;
  - a correctly linked plain-SHA-256 row appended by the DB owner is reported, and so is a keyed row under a guessed key;
  - a legacy (all `sha256`) chain verifies and is continued by keyed rows;
  - after a key change, old rows fail until the old key is in `previousHashKeys`.
- The existing audit suites (`audit.test.ts`, the 5,200-row verifier test in `qa-phase3-integrity`) pass unchanged.

### SEC8-016 — sharp pixel limit and nonce CSP (fixed)
- **sharp:**
  - `apps/api/src/modules/files/image.ts` `decodeImage()` wraps every sharp call (upload metadata, thumbnails, the
    template seed and the test helper) with an explicit `limitInputPixels: 50_000_000`. Callers can lower it but never
    raise it.
  - An upload over 50 MP is a 400 "The image is too large; at most 50 megapixels are allowed." The header-only metadata
    read refuses it, so nothing large is decoded.
  - An older stored image over the limit is served as the original instead of a thumbnail, so it never becomes a 500.
  - Test `[SEC8-016]`: a crafted 10,000 × 10,000 PNG (a few hundred bytes) gets 400. A 56 MP header is refused by
    `decodeImage` even when a caller asks for more; 49 MP passes.
- **CSP:** a nonce-based policy is now built per request in `apps/web/src/middleware.ts` (`src/lib/csp.ts`).
  - `script-src 'self' 'nonce-<128-bit>' 'sha256-<theme boot script>' 'strict-dynamic'`, with `'unsafe-eval'` in dev
    only. **No `'unsafe-inline'` for scripts any more.**
  - Next stamps the nonce on its own scripts.
  - The one inline script of our own (the theme boot script in the root layout) is allowed by its hash. A nonce prop on
    a React-rendered `<script>` fails hydration, because browsers hide the attribute.
  - The root layout is `dynamic = 'force-dynamic'`, so no page is prerendered without a nonce.
  - The other headers stay in `next.config.ts`.
  - `style-src` keeps `'unsafe-inline'` (React `style` props and component inline styles). Style injection cannot run
    script.
- **Browser check:** headless Chromium 141 on the dev server (:3122) against the polish API (:4122).
  - Pages: login, then the dashboard, a document page (`/docs/indent/<id>`, IND/26-27/00001), a report page (the
    built-in Audit trail report), a template editor page, and `/approvals`, `/docs/indent`, `/reports`, `/stock`,
    `/procurement`, `/dashboard/design`, `/audit`, `/config/forms`, `/masters/item`.
  - Result: **0 CSP violations and no hydration warnings.** Every `<script>` in the HTML carries the nonce. The stored
    dark theme still applies before paint (the hashed boot script runs).
  - An injected `<img onerror>` handler is blocked (`script-src-attr`).
  - The only console errors are the pre-existing `favicon.ico` 404 and the unauthenticated `/auth/refresh` 401 on the
    login page.
- **Not verified:** the production build (`next build` still OOMs on this shared machine). The middleware and
  `force-dynamic` behave the same in `next start`, but a CI e2e run on the standalone build should confirm it.

### SEC8-013 — upgrades done in this round
- Checked with `pnpm audit --prod`. Before: 31 (11 high, 18 moderate, 2 low). After: **11 (3 high, 7 moderate, 1 low)**.
- **nodemailer `6.9.16 → 10.0.16`** clears all 16 nodemailer advisories (5 high).
  - Release of 2026-10-07; ≥ 10.0.10 fixes every listed CVE.
  - No code change was needed. The CJS build still exports `createTransport`, and `nodemailer/lib/mail-composer` is
    still an exported subpath.
  - Tests: the notify suites (`notify.units` covers MIME building and the SMTP error mapping; `notify.channels/api/engine/webhooks`; `qa-batch-notify`) and `reports.delivery`.
  - An extra SMTP smoke against a local fake SMTP server checked the adapter's options with AUTH, UTF-8 subject and a
    PDF attachment: it got 250, and a 550 RCPT still surfaces as `responseCode 550` (permanent).
  - `@types/nodemailer` 6 stays for the `lib/mail-composer` typings.
- **sharp `0.34.4 → 0.35.5`** clears 3 high advisories (libvips/libheif/librsvg).
  - The API needed only type-only imports in `image.ts`. Next's optional copy is overridden too (`pnpm-workspace.yaml`
    `"next>sharp": "0.35.5"`); its image optimizer still loads.
  - Tests: `files`, `templates*` (PDF with logos via SVG → PNG), `sec-phase8`.
- **csv-parse `5.6.0 → 7.0.3`** clears 1 moderate advisory. The `csv-parse/sync` `parse` options are unchanged. Test:
  `records.import`.
- **Left open:**
  - kysely 0.27 → ≥ 0.28.17: a 0.x minor with breaking changes across the whole DB layer, and the vulnerable APIs are
    unused, as above. Do it as its own change with a full suite plus E2E;
  - file-type 16 → ≥ 21.3.1: ESM-only. The ASF loop is blocked (SEC8-002), and the ZIP-bomb advisory is in Nest's unused
    copy (20.4.1);
  - @nestjs/core 10 → 11: a major;
  - fast-xml-parser 4 → 5, uuid 8/9 → 11 and @smithy/config-resolver: transitive under the AWS SDK and exceljs, with
    unaffected usage as above.

### Other changes in this round
- **QA3-BUG-003** (UoM decimals, see `phase-3-report.md`): new server-side 400s on quantities with more decimals than
  their unit allows. Test fixtures were adjusted, not the rule.
- **Migrations added:** `0022_sec8_audit_hmac.sql` only.
- **Tests run:**
  - targeted suites while iterating: qa-phase3-integrity, documents, documents.list, ledger, stock.*, grn, issue,
    qa-phase5-*, procurement.quotes/tax, reports.engine, report-pack, integrity.qty-ledger, sec-phase8, audit,
    notify.*, files, templates.*, records.import, reports.delivery;
  - then one full API suite: **80 files (79 passed, 1 skipped), 991 tests passed, 16 skipped, 0 failed**
    (464 s, run next to the load-test agent).
- **Flake in that run:** vitest reported 2 unhandled `ioredis` "Connection is closed" rejections, raised during
  app teardown after the `[QA3-BUG-013]` boot test in `qa-phase3-sla.test.ts`. They made the run exit non-zero. The file
  passed cleanly twice on its own. It looks like a pre-existing BullMQ/ioredis shutdown race under load and is
  unrelated to this round's changes. It is worth a `quit()`-before-close fix in that test's teardown.
