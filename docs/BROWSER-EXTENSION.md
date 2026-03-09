# Browser Extension

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

| Command | Description | Permission |
|---------|-------------|------------|
| `navigate` | Navigate active tab to a URL | ASK |
| `screenshot` | Capture visible tab as base64 PNG | ALLOW |
| `extract_content` | Extract text, links, forms from page | ALLOW |
| `click` | Click element by CSS selector | ASK |
| `fill` | Fill input field with value | ASK |
| `evaluate` | Execute JavaScript in page context | ASK (dangerous) |
| `get_tabs` | List all open tabs | ALLOW |
| `get_cookies` | Get cookies for a domain | ASK (dangerous) |

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
{ "type": "connect", "version": "1.0.0", "tabCount": 5, "userAgent": "..." }

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
- `evaluate` and `get_cookies` marked as dangerous — require explicit permission approval
- Navigation and interaction require ASK-level approval
- Screenshots and content extraction default to ALLOW

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
