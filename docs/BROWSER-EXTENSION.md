# Browser Extension

> **v2.0.0**: Extension upgraded from 8 to 24 commands. New capabilities include tab management, advanced interactions (hover, drag, scroll, key press), storage access, console/network monitoring, and dialog handling. New permissions required: `tabs`, `cookies`.

Chrome extension that gives AI agents access to the user's real browser — with existing cookies, sessions, and authentication. No bot detection, no Playwright sandboxes.

## Why

Playwright runs in an isolated browser with no cookies or login state. Many sites detect and block automated browsers. The browser extension bridges to the user's real Chromium instance, so agents can:

- Navigate and interact with authenticated pages
- Use existing OAuth sessions (GitHub, Google, etc.)
- Bypass bot detection and CAPTCHAs
- Take screenshots of real page state

## Architecture

```
Agent Worker
    │
    ▼
BrowserExtTool (src/tools/browser-ext/)
    │
    ▼
BrowserBridgeService (src/api/browser-bridge.ts)
    │ WebSocket (ws://localhost:3005/ws/browser-bridge)
    │ (dedicated bridge, separate from /gateway protocol)
    ▼
Chrome Extension (browser-extension/)
    │
    ├─ Service Worker (background.js) — WebSocket client, command dispatch
    ├─ Content Script (content.js) — element highlighting
    └─ Popup (popup.html/js) — settings, connect/disconnect
```

Commands are sent as JSON over WebSocket with a unique ID. The extension executes the command and returns the result (or error) with the same ID for promise resolution.

## Setup

### 1. Install Chromium

```bash
# Manjaro / Arch
sudo pacman -S chromium

# Ubuntu / Debian
sudo apt install chromium-browser

# Fedora
sudo dnf install chromium
```

### 2. Load the Extension

1. Open `chromium://extensions`
2. Enable **Developer mode** (toggle, top right)
3. Click **Load unpacked**
4. Select the `browser-extension/` directory (or `~/.assistant/browser-extension/` if installed via setup wizard)

### 3. Configure

1. Click the extension icon in the toolbar
2. Enter the backend URL: `ws://localhost:3005`
3. Enter your API key (master key from `.env`)
4. Click **Connect**

The badge shows **ON** when connected, **OFF** when disconnected.

### Automated Install

Run the setup wizard (`bun run setup`). If Chromium is detected, a "Browser Extension" checkbox appears in optional extras. Selecting it copies the extension to `~/.assistant/browser-extension/` and prints loading instructions.

## Available Commands

### Navigation & Tabs

| Command | Description | Permission |
|---------|-------------|------------|
| `navigate` | Navigate active tab to a URL | ASK |
| `new_tab` | Open a new browser tab | ASK |
| `close_tab` | Close a tab by ID | ASK |
| `select_tab` | Switch focus to a tab by ID | ASK |
| `get_tabs` | List all open tabs | ALLOW |

### Screenshots & Content

| Command | Description | Permission |
|---------|-------------|------------|
| `screenshot` | Capture visible tab as base64 PNG | ALLOW |
| `extract_content` | Extract text, links, forms from page | ALLOW |

### Interactions

| Command | Description | Permission |
|---------|-------------|------------|
| `click` | Click element by CSS selector; supports `doubleClick` parameter | ASK |
| `fill` | Fill input field with value | ASK |
| `select` | Select option in a `<select>` element | ASK |
| `hover` | Hover over an element by CSS selector | ASK |
| `press_key` | Press a keyboard key (e.g. Enter, Tab, Escape) | ASK |
| `scroll` | Scroll the page or an element by pixel offset | ASK |
| `drag` | Drag an element from one position to another | ASK |

### Waiting & Debugging

| Command | Description | Permission |
|---------|-------------|------------|
| `wait_for` | Wait for an element or condition to appear | ALLOW |
| `highlight` | Visually highlight an element on the page | ALLOW |

### JavaScript & State

| Command | Description | Permission |
|---------|-------------|------------|
| `evaluate` | Execute JavaScript in page context | ASK (dangerous) |
| `get_cookies` | Get cookies for a domain | ASK (dangerous) |
| `set_cookies` | Set cookies for a domain | ASK (dangerous) |
| `get_storage` | Read localStorage or sessionStorage values | ASK (dangerous) |
| `set_storage` | Write localStorage or sessionStorage values | ASK (dangerous) |

### Monitoring

| Command | Description | Permission |
|---------|-------------|------------|
| `get_console` | Retrieve captured console log entries | ALLOW |
| `get_network` | Retrieve captured network request/response log | ASK |

### Dialogs

| Command | Description | Permission |
|---------|-------------|------------|
| `handle_dialog` | Accept or dismiss a browser dialog (alert, confirm, prompt) | ASK |

## Agent Roles with Browser Extension

The `browser-ext` tool is available to these roles:

| Role | Why |
|------|-----|
| research | Browse authenticated sources |
| qa | Test real browser behavior |
| security | Assess authenticated endpoints |
| ai | Interact with AI platforms |
| general | Fallback access |

## WebSocket Protocol

### Extension → Backend

```json
// Handshake
{ "type": "connect", "version": "2.0.0", "tabCount": 5, "userAgent": "..." }

// Command result
{ "type": "result", "id": "cmd-123", "result": { ... } }

// Error result
{ "type": "result", "id": "cmd-123", "error": "Element not found" }

// Tab change notification
{ "type": "tab_update", "tab": { "id": 1, "url": "...", "title": "..." } }
```

### Backend → Extension

```json
// Connected acknowledgment
{ "type": "connected" }

// Command request
{ "type": "command", "id": "cmd-123", "command": "navigate", "params": { "url": "..." } }

// Pong
{ "type": "pong" }
```

## Security

- WebSocket authenticated via master key (query parameter)
- `evaluate`, `get_cookies`, `set_cookies`, `get_storage`, `set_storage`, and `get_network` marked as dangerous — require explicit permission approval
- Navigation, tab management, and interaction commands require ASK-level approval
- Screenshots, content extraction, console capture, and element highlighting default to ALLOW
- v2.0.0 requires the `tabs` and `cookies` browser permissions

## Troubleshooting

**Extension won't connect:**
- Check that the backend is running (`bun run dev`)
- Verify the API key matches `MASTER_KEY` in `.env`
- Check the service worker console in `chromium://extensions` for errors

**Commands time out:**
- Default timeout is 30 seconds
- Check that the target tab is loaded and responsive
- Try with a specific `tabId` if multiple tabs are open

**Badge shows "!":**
- Connection error or authentication failure
- Click the extension icon to see status details
