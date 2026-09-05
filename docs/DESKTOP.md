# Desktop App (Tauri)

Octipus ships a native desktop client built on [Tauri v2](https://tauri.app). It
is a **thin client** — it does not embed or start a backend. It connects to any
Octipus backend you point it at: a local `octi start`, another machine on your
LAN, or a remote deployment. On first launch (or when the saved backend is
unreachable) the app shows a connection screen where you enter the backend URL
and log in.

> Related: [CONFIGURATION.md](./CONFIGURATION.md) (backend setup),
> [DOCKER.md](./DOCKER.md) (running the backend in Docker).

---

## TL;DR

| Question | Answer |
|---|---|
| What is it? | A native desktop window wrapping the Octipus web UI (Vite static build) |
| Does it run a backend? | **No** — it connects to an existing one |
| How to launch | `octi desktop` (dev) · `octi desktop --build` (distributable bundle) |
| Install deps (once) | `scripts/install-desktop-deps.sh` or `install.sh --desktop` |
| Required extras | Rust toolchain + Tauri v2 system libs (webkit2gtk-4.1 on Linux) |
| Tauri config | `web/src-tauri/tauri.conf.json` |
| Web dev port | `3008` (separate from the regular web UI on `3007`) |

---

## Prerequisites

### 1. Core deps (already installed if you followed quick start)

```bash
npm install
cd web && npm install && cd ..
```

The Tauri CLI is pulled from `web/` by `npm install` — no separate `cargo
install tauri-cli` needed.

### 2. Desktop-only deps (Rust + system libs)

The desktop app needs:

- The **Rust toolchain** (`cargo`) — installed automatically by the script via
  `rustup` if not present.
- **Tauri v2 system libraries** — platform-specific:

| Platform | Key package |
|---|---|
| Arch / Manjaro | `webkit2gtk-4.1` |
| Debian / Ubuntu | `libwebkit2gtk-4.1-dev` |
| Fedora | `webkit2gtk4.1-devel` |
| openSUSE | `webkit2gtk-4_1-devel` |
| macOS | Xcode Command Line Tools |

Install everything in one shot:

```bash
# From the repo root
scripts/install-desktop-deps.sh

# Or skip system-lib installation (CI/containers where you manage them yourself)
scripts/install-desktop-deps.sh --no-sudo
```

The script is **idempotent** — re-running it is a no-op when all deps are
already present. It also warms the Cargo cache (`cargo fetch`) so the first
build doesn't stall on a slow network.

You can also fold this into the one-shot installer:

```bash
curl -fsSL https://raw.githubusercontent.com/PatriceA/octipus/main/scripts/install.sh | bash -s -- --desktop
```

---

## Launching

### Development mode

```bash
octi desktop
```

This runs `npm run tauri:dev` in `web/`, which:
1. Starts the Vite dev server on port `3008`.
2. Opens the Tauri window pointed at that dev server.

Changes to the web frontend hot-reload in the window. The backend must already
be running elsewhere (`octi start` or a remote URL — the app prompts you for it
on first launch).

### Build a distributable bundle

```bash
octi desktop --build
```

Produces a platform-specific installer/binary under
`web/src-tauri/target/release/bundle/`. This is equivalent to
`npm run tauri:build` in `web/`.

---

## Connecting to a backend

The desktop app is backend-agnostic. On first launch (or when it cannot reach
the previously saved backend) it shows a connection screen. Enter the backend
URL, e.g.:

| Scenario | URL |
|---|---|
| Local `octi start` | `http://localhost:3005` |
| Another machine on the LAN | `http://192.168.1.x:3005` |
| Remote / cloud deployment | `https://your.octipus.example.com` |

Authentication uses a **bearer token** (the web UI cookie is translated to an
`Authorization: Bearer` header for cross-origin compatibility). Log in with your
normal Octipus credentials.

If you are running a local backend for the first time:

```bash
octi start          # bring up the backend
octi desktop        # open the desktop client
```

`octi desktop` will detect no running backend on the default port and remind you
to start one (or point at a remote URL from the connection screen).

---

## Architecture

```
Tauri shell (web/src-tauri/)
    │
    ▼
Vite static build (web/out/)       — served by the dev server (port 3008 in dev)
    │
    ▼  HTTPS / HTTP  (bearer token auth)
Octipus backend (port 3005 by default)
```

The Tauri app itself only provides the native window, OS integration, and the
application bundle. All AI logic stays in the backend. There is no Rust business
logic in the shell beyond window management.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `octi desktop` says `cargo not found` | Rust toolchain missing | Run `scripts/install-desktop-deps.sh` |
| Build fails: `webkit2gtk` not found | Tauri system libs missing | Run `scripts/install-desktop-deps.sh` (with sudo, the default) |
| Window opens but shows a blank page | Vite dev server not ready yet | Wait a few seconds; the dev server starts before the window opens but can be slow on first run |
| Connection screen loops / can't log in | CORS misconfiguration, or the backend is not running | Confirm `octi start` is up; check `http://localhost:3005/api/health/ready` |
| App connects but requests fail | Bearer-token mismatch | Log out and log in again from the connection screen to refresh the token |
| `tauri:dev` crashes with Chromium/WebKit errors | WebKit/webkit2gtk version mismatch | Re-run `scripts/install-desktop-deps.sh` to upgrade system libs |
| Slow first build | Cargo compiling from scratch | Expected — subsequent builds are incremental. `scripts/install-desktop-deps.sh` pre-fetches crates to reduce the wait |

---

## See also

- `web/src-tauri/tauri.conf.json` — Tauri configuration (window size, CSP, bundle targets)
- `web/src-tauri/` — Rust source for the shell
- `scripts/install-desktop-deps.sh` — dependency installer
- `bin/octi` (`cmd_desktop`) — the `octi desktop` command implementation
