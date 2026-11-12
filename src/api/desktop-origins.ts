/**
 * The Tauri desktop client's own local origins: the `tauri://localhost` /
 * `http://tauri.localhost` custom-protocol origin in the packaged app, and the
 * dev server port (3008) during `octi desktop` dev. Always allowed by CORS
 * (src/api/server.ts) and by the cross-site check of cookie-signed changes
 * (src/api/plugin-route-guard.ts).
 */
export const DESKTOP_ORIGINS: readonly string[] = [
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'http://localhost:3008',
];
