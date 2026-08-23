# Node is pinned to 24.9, not floated: `crypto.argon2` (every password hash)
# landed there, and `fs.glob` needs 22. A floating tag that happens to be new
# enough today would fail at runtime on login, not at build.
# ---- Build stage ----
FROM node:24.9-bookworm AS build
WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm install

# Copy source
COPY src/ src/
COPY scripts/ scripts/
COPY bin/ bin/
COPY web/ web/
COPY mcp-server/ mcp-server/
COPY tsconfig.json ./

# Bundle the backend. `start` runs this artifact, not the source under a
# loader, so the image ships what the tests exercised.
RUN npx tsx scripts/build.ts

# Build web frontend
# NEXT_PUBLIC_API_PORT is baked into client JS at build time (used for WebSocket)
ARG NEXT_PUBLIC_API_PORT=3005
ENV NEXT_PUBLIC_API_PORT=${NEXT_PUBLIC_API_PORT}
RUN cd web && npm install && npm run build

# ---- Runtime stage ----
FROM node:24.9-bookworm-slim
WORKDIR /app

# Install runtime system dependencies
# Core: curl, git, ca-certificates (networking & version control)
# CLI tools: jq, make, wget, tree, less, file, procps, rsync, ripgrep
# Archives: zip, unzip
# Remote access: openssh-client
# Scripting: python3-minimal
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    jq \
    make \
    wget \
    tree \
    less \
    file \
    procps \
    rsync \
    ripgrep \
    fd-find \
    zip \
    unzip \
    openssh-client \
    python3-minimal \
    && rm -rf /var/lib/apt/lists/*

# Copy built app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/web/serve.mjs ./web/serve.mjs
COPY --from=build /app/web/package.json ./web/package.json

# Source stays in the image: the migration runner, the setup wizard and the
# TUI are still run from it, and stack traces resolve against it.
COPY package.json tsconfig.json ./
COPY src/ src/
COPY scripts/ scripts/
COPY mcp-server/ mcp-server/
COPY eval/ eval/
COPY bin/ bin/
# Product docs — auto-indexed into the knowledge base at boot so users can ask
# "how do I set up X?" (see src/db/seed-docs.ts). Without this the indexer
# finds nothing in the image.
COPY docs/ docs/

# Create data directories
RUN mkdir -p /data/workspace /data/documents /data/extensions

# Pre-bake optional capabilities so the container reports them as
# `available` via /api/capabilities on first boot. The streamlined
# setup wizard surfaces these so an admin connecting remotely with
# `octi setup --remote …` doesn't have to install them in-container.
#
# - Playwright Chromium → `browser`, `visual` tools
# - mcp-server build    → `mcp` capability (external MCP clients)
#
# Browsers install to a shared, world-readable path so the non-root
# runtime user (below) can launch them — the default per-user cache
# (~/.cache/ms-playwright) would be unreadable after the USER switch.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install chromium && \
    chmod -R a+rX /ms-playwright && \
    cd mcp-server && npm install --silent && npm run build --silent && cd ..

# Environment defaults
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=3005 \
    WEB_PORT=3007 \
    STORAGE_MODE=external \
    WORKSPACE_ROOT=/data/workspace \
    DOCUMENTS_PATH=/data/documents \
    LOG_FORMAT=json

# Drop root. The node image ships a non-root `node` user (uid 1000);
# a compromised agent shell tool would otherwise run as root inside the
# container (and, if the Docker socket is mounted, host-root-equivalent).
RUN chown -R node:node /app /data
USER node

# Health check — probe readiness (DB + Redis reachable), not just liveness,
# so the container is only "healthy" when it can actually serve requests.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3005/api/health/ready || exit 1

EXPOSE 3005 3007

COPY --chown=node:node docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh
ENTRYPOINT ["/app/docker-entrypoint.sh"]
