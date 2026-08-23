#!/usr/bin/env bash
#
# smoke-test.sh — the highest-value "does a fresh install actually run?" check.
#
# Exercises exactly what a new self-hoster does first, with zero external
# services (embedded PGlite, no Postgres/Redis needed):
#
#   1. `octi setup --non-interactive` in embedded storage mode
#   2. `octi doctor`                    (must exit 0)
#   3. boot the backend, wait for `/api/health/ready` to report ready
#
# Used by .github/workflows/install-smoke.yml and runnable locally:
#   npm ci && bash scripts/smoke-test.sh
#
set -euo pipefail

PORT="${PORT:-3005}"
DATA_DIR="$(mktemp -d)"
# The wizard reads its own port from OCTIPUS_SETUP_API_PORT (default 3005) and
# will happily ADOPT a backend that already answers there — so with a dev
# instance running, `octi setup` registered its smoke admin in the developer's
# real database instead of this run's throwaway one. Pin the wizard to the port
# this script actually owns, and refuse to run if anything is already on it.
export OCTIPUS_SETUP_API_PORT="$PORT"
if curl -sf -m 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "::error::something is already serving http://127.0.0.1:${PORT} — stop it, or run with PORT=<free port>."
  echo "         (the smoke test would otherwise register its admin against that instance)"
  exit 1
fi
export STORAGE_MODE=embedded
export OCTIPUS_SETUP_STORAGE=embedded
export OCTIPUS_SETUP_DATA_DIR="$DATA_DIR"
export DATA_DIR
export PORT
# Ephemeral 32+ char secrets (config validation requires ≥32 chars).
export MASTER_KEY="smoke-master-key-0123456789-abcdefghijklmnop"
export JWT_SECRET="smoke-jwt-secret-0123456789-abcdefghijklmnop"
export SESSION_SECRET="smoke-session-secret-0123456789-abcdefghij"
# Non-interactive admin (password policy: upper+lower+digit).
export OCTIPUS_SETUP_ADMIN_USER="smokeadmin"
export OCTIPUS_SETUP_ADMIN_PASS="SmokeAdminPass123"

# `octi setup` writes `.env` in the working directory, and this script runs from
# the repo root — so on a developer machine it overwrites a real bootstrap file.
# It preserves MASTER_KEY/JWT/SESSION on a rerun (setup-wizard reuses existing
# secrets), but it rewrites the storage targets to this run's throwaway embedded
# database, which points a working install at nothing. Stash it and put it back.
# In CI there is no `.env` and both branches are no-ops.
ENV_BACKUP=""
if [ -f .env ]; then
  ENV_BACKUP="$(mktemp)"
  cp .env "$ENV_BACKUP"
  echo "── stashed your .env (restored on exit) ──"
fi

server_pid=""
cleanup() {
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
  rm -rf "$DATA_DIR" 2>/dev/null || true
  if [ -n "$ENV_BACKUP" ]; then
    cp "$ENV_BACKUP" .env && rm -f "$ENV_BACKUP"
  fi
}
trap cleanup EXIT

echo "── 1/3 · octi setup --non-interactive (embedded) ──"
npx tsx scripts/setup-wizard.ts --non-interactive

echo "── 2/3 · octi doctor ──"
npx tsx scripts/doctor.ts

echo "── 3/3 · boot backend + health check ──"
npx tsx --import ./scripts/md-loader.mjs src/index.ts > /tmp/octipus-smoke-server.log 2>&1 &
server_pid=$!

ready=0
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:${PORT}/api/health/ready" | grep -q '"ready":true'; then
    ready=1
    break
  fi
  # Fail fast if the server process died.
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "::error::backend process exited before becoming ready"
    tail -40 /tmp/octipus-smoke-server.log || true
    exit 1
  fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  echo "::error::backend did not become ready within 60s"
  tail -40 /tmp/octipus-smoke-server.log || true
  exit 1
fi

echo "✓ smoke test passed — setup, doctor, and a booted backend all healthy."
