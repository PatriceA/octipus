#!/usr/bin/env bash
# Octipus one-shot installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/PatriceA/octipus/main/scripts/install.sh | bash
#
# What it does:
#   1. Detects platform + verifies prerequisites (git, bun).
#   2. Clones the repo into ~/.octipus/app (skips if present).
#   3. Installs dependencies.
#   4. Runs `bun run setup` (interactive — picks Ollama / LiteLLM / direct provider).
#   5. Prints the next-step command.
#
# Idempotent: re-running pulls the latest main, re-installs deps, re-runs setup.

set -eu

REPO_URL="${OCTIPUS_REPO:-https://github.com/PatriceA/octipus.git}"
INSTALL_DIR="${OCTIPUS_INSTALL_DIR:-$HOME/.octipus/app}"
BRANCH="${OCTIPUS_BRANCH:-main}"

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

# ─── Check bun (install if missing) ────────────────────────────────────────
if ! command -v bun >/dev/null 2>&1; then
  warn "bun not found — installing via official script..."
  curl -fsSL https://bun.sh/install | bash
  # shellcheck disable=SC1090
  if [ -f "$HOME/.bun/bin/bun" ]; then export PATH="$HOME/.bun/bin:$PATH"; fi
  if ! command -v bun >/dev/null 2>&1; then
    err "bun install failed. Install manually from https://bun.sh and re-run."
    exit 1
  fi
fi
ok "bun: $(bun --version)"

# ─── Clone or update ───────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  say "Found existing checkout at $INSTALL_DIR — pulling latest..."
  git -C "$INSTALL_DIR" fetch origin "$BRANCH" --quiet
  git -C "$INSTALL_DIR" checkout "$BRANCH" --quiet
  git -C "$INSTALL_DIR" pull --quiet --ff-only origin "$BRANCH" || warn "Pull failed (uncommitted changes?) — continuing with current HEAD."
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  say "Cloning $REPO_URL → $INSTALL_DIR"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"
ok "Repository ready at $INSTALL_DIR"

# ─── Install deps ──────────────────────────────────────────────────────────
say "Installing backend dependencies..."
bun install --silent
ok "Backend dependencies installed"

if [ -d "$INSTALL_DIR/web" ]; then
  say "Installing web dependencies..."
  (cd "$INSTALL_DIR/web" && bun install --silent)
  ok "Web dependencies installed"
fi

# ─── Build the compiled CLI binary ────────────────────────────────────────
echo ""
say "Building the compiled octi binary..."
bun run build:cli >/dev/null 2>&1 || warn "build:cli failed — bash bin/octi will still work."

# Link or copy the binary onto PATH. Prefer ~/.local/bin (no sudo).
TARGET_BIN_DIR="${OCTIPUS_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$TARGET_BIN_DIR"
if [ -f "$INSTALL_DIR/dist/octi" ]; then
  ln -sf "$INSTALL_DIR/dist/octi" "$TARGET_BIN_DIR/octi"
  ok "octi binary linked at $TARGET_BIN_DIR/octi"
elif [ -f "$INSTALL_DIR/bin/octi" ]; then
  ln -sf "$INSTALL_DIR/bin/octi" "$TARGET_BIN_DIR/octi"
  ok "octi (bash) linked at $TARGET_BIN_DIR/octi"
fi

# If TARGET_BIN_DIR isn't already on PATH, advise the user (one-shot).
case ":$PATH:" in
  *":$TARGET_BIN_DIR:"*) : ;;
  *)
    warn "Add $TARGET_BIN_DIR to PATH so 'octi' is reachable:"
    echo "    echo 'export PATH=\"$TARGET_BIN_DIR:\$PATH\"' >> ~/.bashrc   # or ~/.zshrc"
    ;;
esac

# ─── Run setup wizard ──────────────────────────────────────────────────────
echo ""
say "Launching the setup wizard..."
echo "${DIM}(storage, secrets, admin account, provider, default model, capabilities)${NC}"
echo ""
# Prefer the linked `octi` binary so the wizard runs through the same
# code path users will hit later. Fall back to the script directly if
# PATH doesn't include the bin dir yet.
if command -v octi >/dev/null 2>&1; then
  octi setup
else
  bun run scripts/setup-wizard.ts
fi

# ─── Done ──────────────────────────────────────────────────────────────────
echo ""
ok "Installation complete."
echo ""
echo "Next:"
echo "  cd $INSTALL_DIR"
echo "  octi start         # full stack"
echo "  octi tui           # terminal chat"
echo "  octi doctor        # check what's wired"
echo ""
