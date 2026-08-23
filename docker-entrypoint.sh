#!/bin/sh
set -e

# Serve the built web bundle in the background. Static files plus a same-origin
# proxy to the API — no framework server, and no node_modules in the web layer.
cd /app/web
WEB_PORT=${WEB_PORT:-3007} node serve.mjs &
WEB_PID=$!

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
node dist/index.js &
BACKEND_PID=$!

# Forward termination to both children on container stop.
term() {
  kill -TERM "$WEB_PID" "$BACKEND_PID" 2>/dev/null || true
}
trap term TERM INT

# Supervise: if EITHER the web frontend or the backend exits, tear the
# container down so the restart policy (compose/k8s) brings it back
# cleanly. Previously the backend ran as the foreground process and a
# crashed web UI left the container reporting "healthy" with a dead UI.
while kill -0 "$WEB_PID" 2>/dev/null && kill -0 "$BACKEND_PID" 2>/dev/null; do
  sleep 5
done

if kill -0 "$BACKEND_PID" 2>/dev/null; then
  echo "[octipus] web frontend exited — shutting down container" >&2
else
  echo "[octipus] backend exited — shutting down container" >&2
fi

term
exit 1
