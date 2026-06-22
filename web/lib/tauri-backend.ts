/**
 * Tauri desktop integration for the API client.
 *
 * The desktop app is a thin client: it does NOT run its own backend. It
 * connects to whatever Octipus backend the user points it at — a local
 * `octi start`, a host on the LAN, or a remote deployment. The Rust side owns
 * the chosen backend base URL (persisted via tauri-plugin-store); the frontend
 * asks for it at runtime via `get_backend_url` and can change it through the
 * connection screen via `set_backend_url`.
 *
 * In the regular web build none of this runs: `isDesktop()` is false, the
 * Tauri API is never imported, and the existing same-origin proxy is used.
 */

let cachedBase: string | null = null;

/** True only inside the Tauri webview. Safe to call during SSR/build. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Strip trailing slashes so we can append `/api` etc. cleanly. */
function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Resolve (and cache) the backend base URL the desktop client targets, e.g.
 * `http://127.0.0.1:3005`. The Tauri API is dynamically imported so it never
 * lands in the web bundle.
 */
export async function resolveBackendUrl(): Promise<string> {
  if (cachedBase != null) return cachedBase;
  const { invoke } = await import('@tauri-apps/api/core');
  cachedBase = normalizeBase(await invoke<string>('get_backend_url'));
  return cachedBase;
}

/** Persist a new backend base URL and update the cache. */
export async function setBackendUrl(url: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_backend_url', { url });
  cachedBase = normalizeBase(url);
}

/** Synchronously read the cached base URL (null until resolved). */
export function getCachedBackendUrl(): string | null {
  return cachedBase;
}

/** API base, e.g. `http://127.0.0.1:3005/api`. Null until resolved. */
export function getDesktopApiUrl(): string | null {
  return cachedBase == null ? null : `${cachedBase}/api`;
}

/** WS base, e.g. `ws://127.0.0.1:3005`. Derived from the http(s) base. */
export function getDesktopWsBase(): string | null {
  return cachedBase == null ? null : cachedBase.replace(/^http/, 'ws');
}

/**
 * Probe a candidate backend's health endpoint. Used by the connection screen
 * to validate a URL before saving and to gate startup. Returns true on a 2xx.
 */
export async function pingBackend(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${normalizeBase(base)}/api/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
