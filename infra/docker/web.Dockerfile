# Web image (Next.js standalone output).
# Requires apps/web/next.config.* to set:  output: 'standalone'
# and (monorepo) outputFileTracingRoot: path.join(__dirname, '../../')
# Build from the repo root:
#   docker build -f infra/docker/web.Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.example.com/api/v1 -t procure-web .
# NEXT_PUBLIC_* values are inlined at build time, so each environment needs its own image build
# (or the web app must read the API URL at runtime).
ARG NODE_VERSION=22.22.0
ARG PNPM_VERSION=10.28.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/ packages/
RUN find packages -mindepth 2 -not -name package.json -not -type d -delete
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile

FROM deps AS build
ARG NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --filter @procure/web... \
 && mkdir -p apps/web/public \
 && pnpm --filter @procure/web... build \
 && test -f apps/web/.next/standalone/apps/web/server.js \
    || (echo "apps/web must set output: 'standalone' (and outputFileTracingRoot to the repo root)" && exit 1)

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --home /app --shell /usr/sbin/nologin app
WORKDIR /app
COPY --from=build --chown=root:root /repo/apps/web/.next/standalone ./
COPY --from=build --chown=root:root /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=root:root /repo/apps/web/public ./apps/web/public
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/web/server.js"]
