#!/usr/bin/env bash
# Run from a checkout. No host Node/npm required.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
command -v docker >/dev/null || { echo 'Install Docker Engine/Desktop with Compose v2 first.' >&2; exit 1; }
docker compose version >/dev/null
docker info >/dev/null
if [ ! -f .env.compose ]; then
  command -v openssl >/dev/null || { echo 'openssl is required to generate secrets.' >&2; exit 1; }
  {
    echo '# Keep this file: these keys protect your persisted data.'
    for key in MASTER_KEY JWT_SECRET SESSION_SECRET POSTGRES_PASSWORD; do
      printf '%s=%s\n' "$key" "$(openssl rand -hex 32)"
    done
  } > .env.compose
fi
for key in MASTER_KEY JWT_SECRET SESSION_SECRET POSTGRES_PASSWORD; do
  grep -Eq "^${key}=.{32,}$" .env.compose || { echo "Missing/short $key in .env.compose; restore your existing secret." >&2; exit 1; }
done
docker compose --env-file .env.compose up --build -d --wait
# Run the wizard inside the container: no host octi installation needed.
docker compose --env-file .env.compose exec octipus npm run setup -- --remote http://127.0.0.1:3005
printf '\nOpen http://localhost:3017 (default web port). Log in with the account you just created.\n'
echo 'Manage this stack with docker compose --env-file .env.compose logs / stop / up -d.'
