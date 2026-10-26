#!/usr/bin/env bash
# Isolated dev environment for one parallel agent: own dev DB, test DB, Redis index and ports.
#   source scripts/agent-env.sh <name> <redis-db 2-15> <api-port> [web-port]
#   agent_db_reset     # migrate + seed the agent's dev DB from scratch
#   agent_api_start    # build-free start of apps/api/dist on API_PORT (logs to /tmp/claude-0/agent-<name>-api.log)
#   agent_api_stop
# Tests: `cd apps/api && pnpm test` automatically uses TEST_DB / TEST_REDIS_DB exported here.
set -e
AGENT_NAME=${1:?name}; AGENT_REDIS=${2:?redis db}; export API_PORT=${3:?api port}; AGENT_WEB_PORT=${4:-}
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DATABASE_URL="postgres://app_user:app_pass@localhost:5432/procure_${AGENT_NAME}"
export DATABASE_MIGRATOR_URL="postgres://postgres@localhost:5432/procure_${AGENT_NAME}"
export DATABASE_PLATFORM_URL="postgres://platform_user:platform_pass@localhost:5432/procure_${AGENT_NAME}"
AGENT_REDIS_PORT=${AGENT_REDIS_PORT:-6379}
export REDIS_URL="redis://localhost:${AGENT_REDIS_PORT}/${AGENT_REDIS}"
export TEST_DB="procure_test_${AGENT_NAME}"
export TEST_REDIS_DB="$(( (AGENT_REDIS + 1) % 16 ))"
export TEST_REDIS_PORT="$AGENT_REDIS_PORT"
export STORAGE_DIR="${ROOT}/.data/files-${AGENT_NAME}"
export WEB_ORIGIN="http://localhost:${AGENT_WEB_PORT:-3000}"
[ -n "$AGENT_WEB_PORT" ] && export NEXT_PUBLIC_API_URL="http://localhost:${API_PORT}/api/v1" && export PORT="$AGENT_WEB_PORT"
"$ROOT/scripts/dev-services.sh" >/dev/null
[ "$AGENT_REDIS_PORT" != 6379 ] && { redis-cli -p "$AGENT_REDIS_PORT" ping >/dev/null 2>&1 || redis-server --daemonize yes --port "$AGENT_REDIS_PORT" --save "" --appendonly no >/dev/null; }
agent_db_reset() { (cd "$ROOT" && node db/migrate.mjs --reset >/dev/null && redis-cli -p "$AGENT_REDIS_PORT" -n "$AGENT_REDIS" flushdb >/dev/null && pnpm -s --filter @procure/api db:seed); }
agent_api_start() { (cd "$ROOT/apps/api" && nohup node --env-file-if-exists=../../.env dist/main.js > "/tmp/claude-0/agent-${AGENT_NAME}-api.log" 2>&1 & echo $! > "/tmp/claude-0/agent-${AGENT_NAME}-api.pid"); sleep 4; curl -s "localhost:${API_PORT}/health"; echo; }
agent_api_stop() { [ -f "/tmp/claude-0/agent-${AGENT_NAME}-api.pid" ] && kill "$(cat /tmp/claude-0/agent-${AGENT_NAME}-api.pid)" 2>/dev/null; rm -f "/tmp/claude-0/agent-${AGENT_NAME}-api.pid"; }
echo "agent ${AGENT_NAME}: db procure_${AGENT_NAME}, test db ${TEST_DB}, redis ${AGENT_REDIS}/${TEST_REDIS_DB}, api :${API_PORT}${AGENT_WEB_PORT:+, web :$AGENT_WEB_PORT}"
set +e
