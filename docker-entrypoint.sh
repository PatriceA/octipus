#!/bin/sh
set -e

# Start Next.js web frontend in background
cd /app/web
bun node_modules/.bin/next start -p ${WEB_PORT:-3007} &
NEXT_PID=$!

# Start backend (foreground — main process)
cd /app
exec bun run src/index.ts
