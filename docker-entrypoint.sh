#!/bin/sh
set -e

# Start Next.js web frontend in background
cd /app/web
bun node_modules/.bin/next start -p ${WEB_PORT:-3007} &
NEXT_PID=$!

# Print a one-shot setup hint after the backend reports healthy. The
# hint shows when the system has not been set up yet; users run
# `octi setup --remote http://<host>:<port>` from their machine to
# walk through admin/provider/capabilities against this container.
(
  cd /app
  API_PORT_LOCAL=${API_PORT:-3005}
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${API_PORT_LOCAL}/api/health" >/dev/null 2>&1; then
      STATUS=$(curl -fsS "http://127.0.0.1:${API_PORT_LOCAL}/api/settings/setup-status" 2>/dev/null || echo '')
      case "$STATUS" in
        *'"setupComplete":false'*|*'"setupComplete":null'*|'')
          printf "\n\033[1;33m[octipus]\033[0m First-time setup required.\n"
          printf "  Run from your host: \033[1mocti setup --remote http://<container-host>:%s\033[0m\n\n" "${API_PORT_LOCAL}"
          ;;
      esac
      break
    fi
    sleep 1
  done
) &

# Start backend (foreground — main process)
cd /app
exec bun run src/index.ts
