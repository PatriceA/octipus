#!/usr/bin/env bash
# Octipus one-shot installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/PatriceA/octipus/main/scripts/install.sh | bash
#
# What it does:
#   1. Detects platform + verifies prerequisites (git, node).
#   2. Clones the repo into ~/.octipus/app (skips if present).
#   3. Installs locked backend, web, and MCP dependencies; builds and audits them.
#   4. (--desktop) Installs the Rust toolchain + Tauri system libs.
#   5. Runs `npm run setup` (interactive — picks Ollama / LiteLLM / direct provider).
#   6. Prints the next-step command.
#
# Flags (pass after `bash -s --` when piping through curl):
#   --desktop   Also install desktop-app deps (Rust + Tauri system libraries).
#               Equivalent: OCTIPUS_DESKTOP=1. Off by default to keep server
#               installs lean.
#
# Idempotent: re-running pulls the latest main, re-installs deps, re-runs setup.

set -euo pipefail
umask 077

REPO_URL="${OCTIPUS_REPO:-https://github.com/PatriceA/octipus.git}"
INSTALL_DIR="${OCTIPUS_INSTALL_DIR:-$HOME/.octipus/app}"
BRANCH="${OCTIPUS_BRANCH:-main}"

# ─── Args ──────────────────────────────────────────────────────────────────
WANT_DESKTOP="${OCTIPUS_DESKTOP:-}"
SETUP_ARGS=()
SKIP_SETUP=0
START_WEB=0
for arg in "$@"; do
  case "$arg" in
    --desktop) WANT_DESKTOP=1 ;;
    --non-interactive) SETUP_ARGS+=(--non-interactive) ;;
    # Quick: embedded storage with defaults, five prompts, ends with the web UI
    # running and the browser open. The wizard starts the stack itself.
    --quick) SETUP_ARGS+=(--quick) ;;
    --skip-setup) SKIP_SETUP=1 ;;
    --start) START_WEB=1 ;;
    --help|-h)
      echo 'Usage: install.sh [--quick] [--desktop] [--non-interactive] [--skip-setup] [--start]'
      echo 'Requires Git, curl, Node.js >=24.19 and npm. --quick asks five questions and starts the web UI; --start starts it after the full wizard.'
      exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# ─── Colors ────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; DIM="\033[2m"; NC="\033[0m"
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; DIM=""; NC=""
fi

say() { printf "${BOLD}%s${NC}\n" "$1"; }
ok()  { printf "${GREEN}✓${NC} %s\n" "$1"; }
warn(){ printf "${YELLOW}!${NC} %s\n" "$1"; }
err() { printf "${RED}✗${NC} %s\n" "$1" 1>&2; }

# ─── Banner ────────────────────────────────────────────────────────────────
cat <<'EOF'

  ╔═══════════════════════════════════════════════════════════╗
  ║                                                           ║
  ║   Octipus — installing.                                   ║
  ║   One nervous system, eight arms.                         ║
  ║                                                           ║
  ╚═══════════════════════════════════════════════════════════╝

EOF

# ─── Detect platform ───────────────────────────────────────────────────────
case "$(uname -s)" in
  Linux*)  OS=linux ;;
  Darwin*) OS=darwin ;;
  *)
    err "Unsupported platform: $(uname -s)"
    err "Windows users: run scripts/install.ps1 in PowerShell instead."
    exit 1
    ;;
esac
ok "Platform: $OS"

# ─── Check git ────────────────────────────────────────────────────────────
if ! command -v git >/dev/null 2>&1; then
  err "git not found. Install it first (apt/brew/dnf install git)."
  exit 1
fi
ok "git: $(git --version | head -1)"

# ─── Check node ────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  err "Node.js not found. Install Node 24.19 or newer from https://nodejs.org and re-run."
  exit 1
fi
# 24.19 includes the required crypto API and fixes the older module-loader bug.
# Fail before dependency installation on unsupported versions.
NODE_MAJOR_MINOR=$(node -p "process.versions.node.split('.').slice(0,2).map(Number).join('.')")
if node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>24||(a===24&&b>=19)?0:1)"; then
  ok "node: $(node --version)"
else
  err "Node $NODE_MAJOR_MINOR is too old — Octipus needs 24.19 or newer (crypto APIs and module-loader support)."
  exit 1
fi

for tool in npm curl; do
  command -v "$tool" >/dev/null 2>&1 || { err "$tool is required. Install it and retry."; exit 1; }
done
NON_INTERACTIVE_SETUP=0
case " ${SETUP_ARGS[*]:-} " in *" --non-interactive "*) NON_INTERACTIVE_SETUP=1 ;; esac
[ -n "${CI:-}" ] && NON_INTERACTIVE_SETUP=1
if [ "$SKIP_SETUP" = 0 ] && [ "$NON_INTERACTIVE_SETUP" = 0 ]; then
  # curl | bash occupies stdin. Give the wizard its own terminal descriptor.
  if ! { exec 3</dev/tty; } 2>/dev/null; then
    err 'No terminal available. Use --non-interactive with OCTIPUS_SETUP_ADMIN_USER/PASS, or --skip-setup.'
    exit 1
  fi
fi

# ─── Clone or update ───────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  if [ -n "$(git -C "$INSTALL_DIR" status --porcelain)" ]; then
    err 'Existing checkout has local changes. Commit or stash them before updating.'
    exit 1
  fi
  say "Found existing checkout at $INSTALL_DIR — pulling latest..."
  git -C "$INSTALL_DIR" fetch origin "$BRANCH" --quiet
  git -C "$INSTALL_DIR" checkout "$BRANCH" --quiet
  git -C "$INSTALL_DIR" pull --quiet --ff-only origin "$BRANCH"
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  say "Cloning $REPO_URL → $INSTALL_DIR"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"
ok "Repository ready at $INSTALL_DIR"

# ─── Restore secrets from a prior `octi uninstall` ──────────────────────────
# A non-purge uninstall keeps your data and stashes the old .env (which holds
# MASTER_KEY) so the vault stays decryptable. Restore it into the fresh clone
# unless one already exists.
BACKUP_ENV="$HOME/.octipus/.env.uninstall-backup"
if [ -f "$BACKUP_ENV" ] && [ ! -f "$INSTALL_DIR/.env" ]; then
  cp "$BACKUP_ENV" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env" 2>/dev/null || true
  ok "Restored secrets from previous install ($BACKUP_ENV)"
fi

# ─── Install deps ──────────────────────────────────────────────────────────
say "Installing backend dependencies..."
npm ci --include=dev
ok "Backend dependencies installed"

if [ -d "$INSTALL_DIR/web" ]; then
  say "Installing web dependencies..."
  (cd "$INSTALL_DIR/web" && npm ci --include=dev)
  ok "Web dependencies installed"
fi

# ─── Desktop deps (opt-in) ─────────────────────────────────────────────────
# The Tauri desktop app needs the Rust toolchain + system libraries that the
# server/headless install deliberately skips. Only run when --desktop is set.
if [ -n "$WANT_DESKTOP" ]; then
  echo ""
  say "Installing desktop dependencies (Rust + Tauri system libraries)..."
  bash "$INSTALL_DIR/scripts/install-desktop-deps.sh"
  ok "Desktop dependencies installed"
fi

# Build all installed surfaces now so the first start doesn't hide build failures.
say "Building backend, CLI, and web UI..."
npm run build
npm run build:cli
npm --prefix web run build
npm --prefix mcp-server ci --include=dev
npm --prefix mcp-server run build
say "Auditing backend, web, and MCP dependencies..."
npm run audit:all || warn "Dependency audit needs attention. Review the reports above; rerun npm run audit:all from the checkout."

TARGET_BIN_DIR="${OCTIPUS_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$TARGET_BIN_DIR"
ln -sf "$INSTALL_DIR/dist/octi" "$TARGET_BIN_DIR/octi"
export PATH="$TARGET_BIN_DIR:$PATH"
ok "octi linked at $TARGET_BIN_DIR/octi"
echo "For future terminals, add this directory to PATH in your shell profile:"
printf '  export PATH="%s:$PATH"\n' "$TARGET_BIN_DIR"

if [ "$SKIP_SETUP" = 0 ]; then
  say "Launching setup (storage, secrets, admin, provider, optional tools)..."
  if [ "$NON_INTERACTIVE_SETUP" = 1 ]; then
    "$TARGET_BIN_DIR/octi" setup --non-interactive
  else
    "$TARGET_BIN_DIR/octi" setup ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"} <&3
  fi
fi
case " ${SETUP_ARGS[*]:-} " in *" --quick "*) START_WEB=0 ;; esac   # quick setup already started it
if [ "$START_WEB" = 1 ]; then
  [ -f .env ] || { err 'Run setup before starting Octipus.'; exit 1; }
  "$TARGET_BIN_DIR/octi" start web
fi
ok "Installation complete."
printf 'Checkout: %s\nCLI: %s/octi\n' "$INSTALL_DIR" "$TARGET_BIN_DIR"
echo 'Next: octi start web (API :3005, web :3007 by default), then log in with your setup account.'
echo 'Use octi doctor, octi status, octi logs, octi stop; octi tui opens terminal chat.'
