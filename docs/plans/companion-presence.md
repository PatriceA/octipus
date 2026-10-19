# Companion presence — plan and status

The companion (name, persona, shape, colour) lived only inside the chat page.
This plan takes it to where the user is when they are *not* looking at the
chat: another tab, another app, or the window closed. Status as of 2026-10-18.

## Principles

- **One model, many surfaces.** A pure reducer (`src/shared/companion-presence.ts`)
  turns the user's gateway events — every conversation, not just the open
  one — into a state (`working`, `waiting`, `done`, `interrupted`, `sleeping`,
  `idle`) and *moments* (done, needs input, failed). The tab icon, the tray
  and notifications all read it.
- **The user's own companion.** Icons are drawn from the saved appearance
  (`src/shared/companion-frames.ts`, geometry in `src/shared/companion-forms.ts`,
  shared with the chat avatar), not a generic logo.
- **Quiet by default where it costs attention.** Browser notifications are
  opt-in and ask for permission from a click; the chime is opt-in; nothing
  notifies about the conversation already on screen; a reconnect snapshot
  never notifies; one notification per event across the user's tabs.
- **Cross-platform through Tauri.** Tray, native notifications, start at
  login and the single-instance guard are Tauri v2 / official plugins on
  Windows, macOS and Linux; CI compiles and tests the shell on all three.

## Done

| Item | Where |
|---|---|
| Presence reducer and labels, unit tested | `src/shared/companion-presence.ts` |
| Icon frames per state for all three shapes, unit tested | `src/shared/companion-frames.ts` |
| `sleeping` state (dozing after 20 quiet minutes) in the avatar and editor | `web/components/companion/` |
| App-wide presence provider: animated tab icon, unseen count in the title, notifications (click opens the conversation), chime | `web/lib/companion-presence.tsx` |
| Per-device settings card with permission flow and test notification | `web/components/companion/presence-settings.tsx` |
| Tray icon animated in the user's companion, status line, server status, start local server, notifications / start at login / keep running toggles, quit | `web/src-tauri/src/companion.rs` |
| Close-to-tray, start hidden at login, second launch focuses the running app, macOS Dock reopen | `web/src-tauri/src/lib.rs` |
| Windows + macOS `cargo check` / `cargo test` in CI | `.github/workflows/ci.yml` |

## Next ideas (not started)

1. **Answer from the notification.** Approve/deny a permission request without
   opening the app. Browsers need a service worker for notification actions;
   Tauri's desktop notifications have no actions yet, so the tray menu could
   list open requests instead.
2. **Push when no tab is open.** Web Push (service worker + a server-side push
   subscription) so a phone with the PWA installed hears about finished work.
3. **TUI presence.** Terminal notification (OSC 9 / OSC 777, bell) when a turn
   finishes while the terminal is unfocused.
4. **Summon from anywhere.** A global shortcut (Tauri `global-shortcut`
   plugin) that opens a small quick-ask window; recent conversations in the
   tray menu.
5. **Quiet hours.** A schedule that mutes notifications and lets the companion
   doze, per device.
6. **Desk pet (opt-in).** A tiny always-on-top transparent window with the
   companion, for people who want it on screen while they work.
