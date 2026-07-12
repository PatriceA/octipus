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
#   bun install --frozen-lockfile && bash scripts/smoke-test.sh
#
set -euo pipefail

PORT="${PORT:-3005}"
DATA_DIR="$(mktemp -d)"
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

server_pid=""
cleanup() {
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
  rm -rf "$DATA_DIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "── 1/3 · octi setup --non-interactive (embedded) ──"
bun run scripts/setup-wizard.ts --non-interactive

echo "── 2/3 · octi doctor ──"
bun run scripts/doctor.ts

echo "── 3/3 · boot backend + health check ──"
bun run src/index.ts > /tmp/octipus-smoke-server.log 2>&1 &
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
