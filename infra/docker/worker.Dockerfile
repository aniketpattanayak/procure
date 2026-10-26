# Worker image: the API image with a different entrypoint. dist/worker.js boots the same Nest module graph without
# HTTP, so every module registers its BullMQ processors and repeatable jobs (outbox relay, SLA sweeps, report
# schedules, stock/quantity drift checks, file cleanup, PDF renders, ...) and starts consuming them.
# Run the API with RUN_WORKERS=off (the production default) when a worker service is deployed.
# Chromium + fonts for PDF jobs come from the API image.
# Build from the repo root:
#   docker build -f infra/docker/api.Dockerfile -t procure-api .
#   docker build -f infra/docker/worker.Dockerfile --build-arg API_IMAGE=procure-api -t procure-worker .
ARG API_IMAGE=procure-api:latest
# hadolint ignore=DL3006
FROM ${API_IMAGE}
ENV PROCESS_TYPE=worker
# No HTTP port: the orchestrator restarts the container when the process exits.
HEALTHCHECK NONE
CMD ["node", "dist/worker.js"]
