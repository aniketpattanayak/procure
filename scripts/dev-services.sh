#!/usr/bin/env bash
# Starts local Postgres 16 and Redis if they are not running (dev workspace). Safe to run repeatedly.
set -euo pipefail
PGDATA=${PGDATA:-/home/claude/.pgdata}
if ! pg_isready -h localhost -q; then
  su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D $PGDATA -l $PGDATA/log -o '-p 5432 -c max_connections=200' start" >/dev/null
  for _ in $(seq 1 20); do pg_isready -h localhost -q && break; sleep 0.5; done
fi
redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes --port 6379 --save '' --appendonly no >/dev/null
pg_isready -h localhost && redis-cli ping
