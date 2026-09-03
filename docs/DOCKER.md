# Docker Deployment

## Overview

Octipus runs as a multi-container Docker application with three services:

| Service | Image | Purpose |
|---------|-------|---------|
| `octipus-app` | Custom (Node + Vite) | API backend + web frontend |
| `octipus-db` | pgvector/pgvector:pg16 | PostgreSQL with vector extensions |

## Quick Start

```bash
# Copy and configure environment
cp .env.example .env.docker

# Build and start
docker compose up --build -d

# View logs
docker compose logs -f octipus
```

**Ports** (configurable via env):

| Port | Default | Service | Env Var |
|------|---------|---------|---------|
| Host API | 3015 | Backend (internal 3005) | `OCTIPUS_API_PORT` |
| Host Web UI | 3017 | Web UI (internal 3007) | `OCTIPUS_WEB_PORT` |
| Host PostgreSQL | 5442 | Database | `POSTGRES_PORT` |

## Volumes

| Volume | Container Path | Purpose |
|--------|---------------|---------|
| `octipus-workspace` | `/data/workspace` | Agent workspace (files created by agents) |
| `octipus-documents` | `/data/documents` | Uploaded documents |
| `octipus-extensions` | `/data/extensions` | Plugins and extensions |
| `octipus-pgdata` | PostgreSQL data | Database persistence |

## Installed CLI Tools

The container includes these tools for agent shell access:

| Category | Tools |
|----------|-------|
| **Core** | bash, curl, wget, git, ca-certificates |
| **Text/Data** | jq, sed, awk, grep, ripgrep, less |
| **Files** | tree, file, zip, unzip, tar, gzip, rsync |
| **Build** | make, node, npm |
| **Scripting** | python3 (minimal) |
| **Remote** | openssh-client (ssh, scp, sftp) |
| **System** | procps (ps, top), coreutils, findutils, diffutils |

## Capabilities & Limitations

Docker containers are isolated from the host system. This affects what Octipus can and cannot access.

### What works

| Capability | Details |
|-----------|---------|
| **Filesystem** | Full access within mounted volumes (`/data/workspace`, `/data/documents`, `/data/extensions`). Agents can read, write, and manage files within these boundaries. |
| **Shell** | Agents can execute commands using any tool installed in the container image (see list above). Commands run inside the container, not on the host. |
| **Git** | Fully functional. Git is installed in the container. Works on any repository within the workspace volume. Clone, commit, push, pull all work (SSH keys need to be mounted or configured). |
| **Browser Extension** | Works. The browser extension runs in the **user's real browser** on the host and connects to the container's WebSocket endpoint (`ws://localhost:{API_PORT}/ws/browser-bridge`). No special Docker configuration needed. |
| **Playwright** | Headless browser runs inside the container. Useful for web scraping and automation that doesn't need user sessions. Requires chromium installation (`npx playwright install chromium --with-deps`). |
| **Database** | Full PostgreSQL with pgvector. Accessible from the container and optionally from the host via the exposed port. |
| **Cache / queue / pub-sub** | Served by the same PostgreSQL instance — key expiry, a queue table, and `LISTEN`/`NOTIFY`. There is no second data service. |
| **MCP Servers** | MCP servers using SSE transport work (network-accessible). Stdio-based MCP servers must be installed inside the container. |
| **Network** | Full outbound network access. Can reach external APIs, webhooks, etc. |

### What does NOT work

| Capability | Reason | Workaround |
|-----------|--------|------------|
| **Host CLI tools** | Container isolation — Octipus cannot see or execute binaries installed on the host OS. | Install tools in the Dockerfile, or use Docker socket to run sibling containers. |
| **Host filesystem** | Only mounted volumes are accessible. The host's home directory, system files, etc. are not visible. | Add additional bind mounts in `docker-compose.yml` for specific host directories you need. |
| **Host processes** | Cannot inspect or manage processes running on the host. | Use the Docker socket to manage other containers. |
| **GUI applications** | No display server in the container. | Use the browser extension (runs on host) for browser-based tasks. |
| **USB/hardware** | No access to host hardware devices. | Not applicable for most Octipus tasks. |

## Docker Socket (Sibling Containers)

The Docker socket is mounted into the container, allowing Octipus to spawn **sibling containers** on the host's Docker engine. This enables running tools that aren't installed in the main image.

```yaml
# docker-compose.yml (already configured)
volumes:
  - //var/run/docker.sock:/var/run/docker.sock
```

### Use cases

- Running language-specific tools (e.g., a Ruby container for Ruby tasks)
- Building and testing Docker images
- Managing other containers in the compose stack

### Security note

Docker socket access is powerful — a container with socket access can manage all containers on the host, including creating privileged containers. The Octipus shell tool requires permission for `docker` commands (elevated command list). Only enable this in trusted environments.

To disable Docker socket access, remove or comment out the socket volume mount in `docker-compose.yml`.

## Adding Host Directory Access

To give Octipus access to specific host directories, add bind mounts:

```yaml
# docker-compose.yml
services:
  octipus:
    volumes:
      # ... existing volumes ...
      - /path/on/host:/data/workspace/host-files:ro  # read-only
      - ~/projects:/data/workspace/projects           # read-write
```

Mount into subdirectories of `/data/workspace` so agents can access them via the filesystem tool.

## Rebuilding

```bash
# Rebuild and restart (preserves data volumes)
docker compose down && docker compose up --build -d

# Full reset (deletes all data)
docker compose down -v && docker compose up --build -d
```

## Troubleshooting

### Container won't start
```bash
docker compose logs octipus    # Check for startup errors
docker compose ps                # Check container status
```

### Browser extension can't connect
- Ensure the API port is exposed and accessible from the host
- The WebSocket URL should be `ws://localhost:{OCTIPUS_API_PORT}/ws/browser-bridge`
- Check that `MASTER_KEY` is set in both `.env.docker` and the browser extension

### SSH from container
To use SSH from within the container, mount your SSH keys:
```yaml
volumes:
  - ~/.ssh:/root/.ssh:ro
```

### Git push/pull requires authentication
For HTTPS: configure a credential helper or use a personal access token.
For SSH: mount SSH keys as above and use SSH remote URLs.
