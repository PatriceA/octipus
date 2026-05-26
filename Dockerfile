# ---- Build stage ----
FROM oven/bun:1.3 AS build
WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json bun.lock* ./
RUN bun install

# Copy source
COPY src/ src/
COPY web/ web/
COPY mcp-server/ mcp-server/
COPY tsconfig.json ./

# Build web frontend
# NEXT_PUBLIC_API_PORT is baked into client JS at build time (used for WebSocket)
ARG NEXT_PUBLIC_API_PORT=3005
ENV NEXT_PUBLIC_API_PORT=${NEXT_PUBLIC_API_PORT}
RUN cd web && bun install && bun run build

# ---- Runtime stage ----
FROM oven/bun:1.3-slim
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
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Copy built app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/web/.next ./web/.next
COPY --from=build /app/web/node_modules ./web/node_modules
COPY --from=build /app/web/public ./web/public
COPY --from=build /app/web/package.json ./web/package.json
COPY --from=build /app/web/next.config.* ./web/

# Copy source (Bun runs TS directly)
COPY package.json bun.lock tsconfig.json ./
COPY src/ src/
COPY mcp-server/ mcp-server/
COPY eval/ eval/
COPY bin/ bin/

# Create data directories
RUN mkdir -p /data/workspace /data/documents /data/extensions

# Pre-bake optional capabilities so the container reports them as
# `available` via /api/capabilities on first boot. The streamlined
# setup wizard surfaces these so an admin connecting remotely with
# `octi setup --remote …` doesn't have to install them in-container.
#
# - Playwright Chromium → `browser`, `visual` tools
# - mcp-server build    → `mcp` capability (external MCP clients)
RUN bunx playwright install chromium && \
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

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3005/api/health/ || exit 1

EXPOSE 3005 3007

COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh
ENTRYPOINT ["/app/docker-entrypoint.sh"]
