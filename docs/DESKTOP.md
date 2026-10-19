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
| Background use | Closing the window keeps the companion in the tray, notifying |

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

Authentication uses a **bearer token** returned by the mobile-login endpoint
and attached as `Authorization: Bearer` for cross-origin requests. Log in with your
normal Octipus credentials.

If you are running a local backend for the first time:

```bash
octi start          # bring up the backend
octi desktop        # open the desktop client
```

`octi desktop` will detect no running backend on the default port and remind you
to start one (or point at a remote URL from the connection screen).

---

## The companion in the tray

The desktop app keeps your companion in the system tray — the notification
area on Windows, the menu bar on macOS, the app-indicator area on Linux — drawn
in the shape and colour you chose on the Persona page and animated by what it
is doing across all of your conversations:

| Icon | Meaning |
|---|---|
| Fidgeting arms | Working on a turn (the tooltip says how many conversations) |
| Yellow `!` badge | A permission request or approval is waiting for you |
| A jump and a sparkle | A turn just finished |
| Slumped and grey | A turn failed, or the connection to the server was lost |
| Eyes closed, `z` | Nothing has happened for twenty minutes |

**Menu.** The first line repeats the status. Below it: *Open Octipus*; the
server line (*running on port 3005*, *not running*, or for a remote backend
*connected* / *not reachable*), checked every ten seconds; *Start local
server*, enabled when the configured backend is on this machine and down — it
runs `octi start` (found next to the app, in `~/.octipus/app`, `OCTIPUS_HOME`
or `PATH`, through a login shell on macOS/Linux so `node` is on the path);
*Notifications*; *Start at login*; *Keep running when the window closes*; and
*Quit Octipus* (the server keeps running — stop it with `octi stop`).

**Clicks.** On Windows a left click opens the window and a right click the
menu. On macOS a click opens the menu, and the Dock icon reopens a hidden
window. Linux panels open the menu on click (app indicators report no clicks
to the app); use *Open Octipus*.

**Background.** With *Keep running when the window closes* on (the default),
closing the window hides it; the app stays connected and keeps notifying. With
*Start at login* on, the app starts hidden in the tray. Launching it again
brings the running app forward instead of opening a second copy.

**Notifications.** Native notifications say when work is done, a question or
approval needs you, or a turn failed. Which of these you get, a soft chime,
and "only when that conversation isn't on screen" are set on the Persona page
under *Presence & notifications* (per computer); the tray's *Notifications*
switch mutes them all. Desktop notifications do not open the conversation when
clicked — use the tray or the window. The browser web UI has the same moments
as browser notifications (opt-in, it asks for permission, and a click opens
the conversation) plus an animated tab icon.

How it fits together: the webview follows every conversation over the gateway
(`src/shared/companion-presence.ts`), draws the icon frames from the saved
appearance (`src/shared/companion-frames.ts`) and hands them to
`companion_update`; a thread in `web/src-tauri/src/companion.rs` flips through
them, so the icon keeps moving while the window is hidden.

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

The Tauri app itself only provides the native window, OS integration (tray,
notifications, start at login), and the application bundle. All AI logic stays
in the backend.

The app commands — `get_backend_url` and `set_backend_url`, and the
companion's `companion_update` (tray frames and status) and `companion_notify`
(a native notification, honouring the tray's mute switch) — are declared in an
app manifest (`web/src-tauri/build.rs`) and granted to the main window in
`capabilities/default.json`; a command no capability grants is refused, and
content from a remote origin cannot call them. The webview gets no permission
on the notification plugin itself. The webview has no permission on
the settings store itself, so the backend URL changes only through
`set_backend_url`, which accepts `http(s)` URLs only. A new command needs both
its line in `build.rs` and its `allow-<command>` permission.

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
| No tray icon on Linux | The app-indicator library is missing, or GNOME has no indicator support | Install `libayatana-appindicator3-1` (the deps script does); on GNOME enable the *AppIndicator and KStatusNotifierItem Support* extension |
| No notifications | System Focus / Do Not Disturb, the app's notifications turned off in system settings, or *Notifications* unchecked in the tray menu | Use *Send a test notification* on the Persona page to check; on macOS allow Octipus under System Settings → Notifications |
| Notifications show "PowerShell" or a terminal as the sender | A dev build (`octi desktop`) is not an installed app | Expected in dev; a bundle from `octi desktop --build`, once installed, notifies as Octipus |
| *Start local server* does nothing | `octi` not found, or `octi start` failed | The app notifies the reason; run `octi start` in a terminal to see the full output |
| Closing the window doesn't quit | *Keep running when the window closes* is on | Quit from the tray menu, or uncheck that item |
| Slow first build | Cargo compiling from scratch | Expected — subsequent builds are incremental. `scripts/install-desktop-deps.sh` pre-fetches crates to reduce the wait |

---

## See also

- `web/src-tauri/tauri.conf.json` — Tauri configuration (window size, CSP, bundle targets)
- `web/src-tauri/` — Rust source for the shell
- `scripts/install-desktop-deps.sh` — dependency installer
- `bin/octi` (`cmd_desktop`) — the `octi desktop` command implementation
