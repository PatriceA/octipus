#!/usr/bin/env bash
# Octipus desktop dependency installer.
#
# Installs everything the Tauri desktop app needs to BUILD that `octi start`
# and `bun install` do not: the Rust toolchain plus the platform's Tauri v2
# system libraries (webkit2gtk et al.). Then warms the Cargo cache.
#
# Server/headless installs stay lean — this is deliberately separate from the
# core install path and only runs when you opt into the desktop app.
#
# Usage:
#   scripts/install-desktop-deps.sh           # detect platform, install, fetch
#   scripts/install-desktop-deps.sh --no-sudo # skip the system-lib step (CI/containers)
#   curl ... | bash -s -- --desktop           # via the one-shot installer
#
# Idempotent: re-running is a no-op when everything is already present.

set -eu
set -o pipefail

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

# ─── Args ──────────────────────────────────────────────────────────────────
USE_SUDO=true
for arg in "$@"; do
  case "$arg" in
    --no-sudo) USE_SUDO=false ;;
    *) warn "Unknown argument: $arg" ;;
  esac
done

# Resolve repo root from this script's location so it works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# `sudo` wrapper: drop the prefix when we're already root or sudo is absent.
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

# ─── 1. Rust toolchain ─────────────────────────────────────────────────────
if command -v cargo >/dev/null 2>&1; then
  ok "Rust toolchain: $(cargo --version)"
else
  say "Rust toolchain not found — installing via rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  # rustup drops cargo here; make it reachable for the rest of this run.
  if [ -f "$HOME/.cargo/env" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env"
  fi
  if ! command -v cargo >/dev/null 2>&1; then
    err "rustup install finished but 'cargo' is still not on PATH."
    err "Open a new shell (or 'source ~/.cargo/env') and re-run."
    exit 1
  fi
  ok "Rust installed: $(cargo --version)"
fi

# ─── 2. Tauri v2 system libraries ──────────────────────────────────────────
install_system_deps() {
  if [ "$USE_SUDO" = false ]; then
    warn "--no-sudo: skipping system libraries (webkit2gtk et al.)."
    warn "Install them yourself if the desktop build fails to link."
    return 0
  fi

  case "$(uname -s)" in
    Darwin)
      if xcode-select -p >/dev/null 2>&1; then
        ok "macOS: Xcode Command Line Tools present (no extra libs needed)."
      else
        say "macOS: installing Xcode Command Line Tools..."
        xcode-select --install || warn "Run 'xcode-select --install' manually, then re-run."
      fi
      return 0
      ;;
    Linux) : ;;
    *)
      warn "Unsupported platform $(uname -s) — install Tauri's system deps manually:"
      warn "  https://tauri.app/start/prerequisites/"
      return 0
      ;;
  esac

  # Linux: branch on the available package manager. Package sets follow the
  # official Tauri v2 prerequisites for each distro family.
  if command -v pacman >/dev/null 2>&1; then
    say "Arch/Manjaro: installing Tauri system libraries (pacman)..."
    # Partial upgrades are unsupported on Arch — a full -Syu avoids the
    # 'installing X violates dependency' wall a stale DB triggers.
    $SUDO pacman -Syu --needed --noconfirm \
      base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 \
      librsvg webkit2gtk-4.1
  elif command -v apt-get >/dev/null 2>&1; then
    say "Debian/Ubuntu: installing Tauri system libraries (apt)..."
    $SUDO apt-get update
    $SUDO apt-get install -y \
      libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev \
      libssl-dev libayatana-appindicator3-dev librsvg2-dev
  elif command -v dnf >/dev/null 2>&1; then
    say "Fedora: installing Tauri system libraries (dnf)..."
    $SUDO dnf install -y \
      webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel \
      librsvg2-devel xdotool-devel
    $SUDO dnf group install -y "c-development" 2>/dev/null \
      || $SUDO dnf install -y @development-tools 2>/dev/null \
      || warn "Could not install the development-tools group — install build tools manually."
  elif command -v zypper >/dev/null 2>&1; then
    say "openSUSE: installing Tauri system libraries (zypper)..."
    $SUDO zypper -n install \
      webkit2gtk-4_1-devel libopenssl-devel curl wget file libayatana-appindicator3-devel librsvg-devel
    $SUDO zypper -n install -t pattern devel_basis || warn "Install the devel_basis pattern manually."
  else
    warn "No supported package manager found (pacman/apt/dnf/zypper)."
    warn "Install Tauri's Linux prerequisites manually:"
    warn "  https://tauri.app/start/prerequisites/#linux"
    return 0
  fi
  ok "System libraries installed."
}
install_system_deps

# ─── 3. Warm the Cargo cache ───────────────────────────────────────────────
TAURI_DIR="$PROJECT_DIR/web/src-tauri"
if [ -f "$TAURI_DIR/Cargo.toml" ]; then
  say "Fetching Rust crates for the desktop app..."
  (cd "$TAURI_DIR" && cargo fetch)
  ok "Rust crates fetched."
else
  warn "web/src-tauri/Cargo.toml not found — skipping crate fetch."
fi

# ─── Done ──────────────────────────────────────────────────────────────────
echo ""
ok "Desktop dependencies ready."
printf "${DIM}%s${NC}\n" "Launch the app:  octi desktop        (build a bundle: octi desktop --build)"
