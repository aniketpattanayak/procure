# API image (NestJS). Also the base of the worker image (worker.Dockerfile runs dist/worker.js) and of the migrate job:
#   docker run --rm -e DATABASE_MIGRATOR_URL=... procure-api node db/migrate.mjs
# Build from the repo root:  docker build -f infra/docker/api.Dockerfile -t procure-api .
#
# Workspace packages: apps/api depends on @procure/formula and @procure/schema (runtime, formula -> schema) and on
# @procure/test-kit (dev only). The `deps` stage copies their manifests and fails the build if apps/api/package.json
# gains a `workspace:` dependency that is not copied here, so a new package can't silently break the image.
#
# PDF rendering (templates/pdf.renderer.ts, reports PDF export) uses playwright-core with headless Chromium. The
# runtime stage installs the Chromium build that matches the bundled playwright-core version (via its own CLI, so
# the revision can never drift from package.json) plus its system libraries and fonts.
ARG NODE_VERSION=22.22.0
ARG PNPM_VERSION=10.28.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install -g pnpm@${PNPM_VERSION} && pnpm --version
WORKDIR /repo

# ---- deps: install from the lockfile only (good layer caching) ------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/formula/package.json packages/formula/
COPY packages/schema/package.json packages/schema/
COPY packages/test-kit/package.json packages/test-kit/
# Guard: every workspace dependency of apps/api (and, transitively, of the copied packages) must be present above.
RUN node -e "\
const fs=require('fs');const seen=new Set();const dirs=fs.readdirSync('packages').filter(d=>fs.existsSync('packages/'+d+'/package.json'));\
const byName=Object.fromEntries(dirs.map(d=>[require('./packages/'+d+'/package.json').name,d]));\
const walk=f=>{const p=require(f);for(const [n,v] of Object.entries({...p.dependencies,...p.devDependencies})){\
if(!String(v).startsWith('workspace:')||seen.has(n))continue;seen.add(n);\
if(!byName[n]){console.error('api.Dockerfile: copy the manifest of workspace package '+n+' in the deps stage');process.exit(1)}\
walk('./packages/'+byName[n]+'/package.json')}};walk('./apps/api/package.json');console.log('workspace deps:',[...seen].join(', '))"
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile

# ---- build ---------------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/formula packages/formula
COPY packages/schema packages/schema
COPY packages/test-kit packages/test-kit
COPY apps/api apps/api
# `@procure/api...` = the api and every workspace package it depends on, built in dependency order
# (schema -> formula -> api). `deploy` copies the built packages into /out/node_modules.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --filter "@procure/api..." \
 && pnpm --filter "@procure/api..." build \
 && pnpm --filter @procure/api deploy --legacy --prod /out \
 && rm -rf /out/src /out/test /out/*.ts /out/tsconfig*.json \
 && test -f /out/dist/main.js && test -f /out/dist/worker.js \
 && test -f /out/node_modules/@procure/formula/dist/index.js \
 && test -f /out/node_modules/@procure/schema/dist/index.js \
 && test -f /out/node_modules/playwright-core/cli.js

# ---- runtime -------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production API_PORT=4000 NODE_OPTIONS=--enable-source-maps \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    STORAGE_DIR=/var/lib/procure/files MAIL_LOG_DIR=/var/lib/procure/mail
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates fontconfig \
      fonts-dejavu-core fonts-liberation fonts-noto-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --home /app --shell /usr/sbin/nologin app \
 && mkdir -p /var/lib/procure/files /var/lib/procure/mail && chown -R 10001:10001 /var/lib/procure
WORKDIR /app
# Amazon RDS CA bundle so `sslmode=require` connections verify the server certificate.
ADD --chmod=0644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem
COPY --from=build --chown=root:root /out ./
# Chromium headless shell matching node_modules/playwright-core (same revision the renderer expects) + its apt
# dependencies. Only the headless shell is needed: the renderer always launches headless, and with no
# PDF_CHROMIUM_PATH playwright-core resolves the shell under PLAYWRIGHT_BROWSERS_PATH itself.
RUN node node_modules/playwright-core/cli.js install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /tmp/* \
 && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH" \
 && fc-cache -f >/dev/null
# Migration runner + SQL (pg resolves from /app/node_modules)
COPY --chown=root:root db/migrate.mjs db/migrate.mjs
COPY --chown=root:root db/migrations db/migrations
COPY --chown=root:root db/policies db/policies
# /var/lib/procure/{files,mail} (created above, owned by uid 10001) are the writable state of the local storage driver
# and the `log` mail provider: docker-compose mounts named volumes there (they inherit the ownership). Production uses
# STORAGE_DRIVER=s3 and real mail providers; Chromium and exports only need a writable /tmp.
USER 10001:10001
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
