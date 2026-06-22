/**
 * Tauri desktop integration for the API client.
 *
 * In the packaged desktop app the UI is a static export served from a custom
 * `tauri://` origin — there is no Next.js dev server and no `/api` rewrite
 * proxy. The backend runs as a Tauri *sidecar* on a loopback port that the
 * user can change at setup time, so the frontend cannot bake the URL at build
 * time. Instead the Rust side owns the chosen port and the frontend asks for
 * it at runtime via the `get_backend_port` command.
 *
 * In the regular web build none of this runs: `isDesktop()` is false, the
 * Tauri API is never imported, and the existing same-origin proxy is used.
 */

let cachedPort: number | null = null;

/** True only inside the Tauri webview. Safe to call during SSR/build. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Resolve (and cache) the loopback port the backend sidecar is listening on.
 * The Tauri API is dynamically imported so it never lands in the web bundle.
 */
export async function resolveBackendPort(): Promise<number> {
  if (cachedPort != null) return cachedPort;
  const { invoke } = await import('@tauri-apps/api/core');
  cachedPort = await invoke<number>('get_backend_port');
  return cachedPort;
}

/** Synchronously read the cached port (null until `resolveBackendPort` runs). */
export function getCachedBackendPort(): number | null {
  return cachedPort;
}

/** Loopback API base, e.g. `http://127.0.0.1:3005/api`. Null until resolved. */
export function getDesktopApiUrl(): string | null {
  return cachedPort == null ? null : `http://127.0.0.1:${cachedPort}/api`;
}

/** Loopback WS base, e.g. `ws://127.0.0.1:3005`. Null until resolved. */
export function getDesktopWsBase(): string | null {
  return cachedPort == null ? null : `ws://127.0.0.1:${cachedPort}`;
}
