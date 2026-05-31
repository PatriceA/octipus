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

# Start backend in background as well so we can supervise both processes.
cd /app
bun run src/index.ts &
BACKEND_PID=$!

# Forward termination to both children on container stop.
term() {
  kill -TERM "$NEXT_PID" "$BACKEND_PID" 2>/dev/null || true
}
trap term TERM INT

# Supervise: if EITHER the web frontend or the backend exits, tear the
# container down so the restart policy (compose/k8s) brings it back
# cleanly. Previously the backend ran as the foreground process and a
# crashed web UI left the container reporting "healthy" with a dead UI.
while kill -0 "$NEXT_PID" 2>/dev/null && kill -0 "$BACKEND_PID" 2>/dev/null; do
  sleep 5
done

if kill -0 "$BACKEND_PID" 2>/dev/null; then
  echo "[octipus] web frontend exited — shutting down container" >&2
else
  echo "[octipus] backend exited — shutting down container" >&2
fi

term
exit 1
