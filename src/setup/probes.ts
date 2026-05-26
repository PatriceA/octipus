/**
 * Shared service/binary probes used by the setup wizard, doctor, and
 * the capability service. Single source of truth — no duplicates.
 *
 * All probes return a discriminated result rather than throwing, so
 * callers can decide whether absence is fatal. Probes never swallow
 * unexpected errors silently — they record the reason on the result.
 */

import { existsSync } from 'node:fs';
import { platform } from 'node:os';

export interface ProbeResult {
  ok: boolean;
  /** Free-form reason when ok === false, or info when ok === true. */
  detail?: string;
  /** Latency in ms, when measurable. */
  latencyMs?: number;
}

/** Open a TCP socket and close it immediately; succeeds if the connect did. */
export async function tcpReachable(host: string, port: number, timeoutMs = 1500): Promise<ProbeResult> {
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const racer = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const connect = Bun.connect({
      hostname: host,
      port,
      socket: { data() {}, open(s) { s.end(); }, error() {} },
    }).catch((err: unknown) => {
      return { __err: err instanceof Error ? err.message : String(err) } as { __err: string };
    });
    const result = await Promise.race([connect, racer]);
    if (timer) clearTimeout(timer);
    const latencyMs = performance.now() - start;
    if (result === null) return { ok: false, detail: `timeout after ${timeoutMs}ms`, latencyMs };
    if (result && typeof result === 'object' && '__err' in result) {
      return { ok: false, detail: result.__err, latencyMs };
    }
    return { ok: true, latencyMs };
  } catch (err) {
    if (timer) clearTimeout(timer);
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** HTTP HEAD-like probe — any 2xx/3xx/4xx counts as "reachable" (5xx = down). */
export async function httpReachable(url: string, timeoutMs = 2000): Promise<ProbeResult> {
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const latencyMs = performance.now() - start;
    if (res.status >= 500) return { ok: false, detail: `HTTP ${res.status}`, latencyMs };
    return { ok: true, detail: `HTTP ${res.status}`, latencyMs };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Fetch JSON or return null. Caller decides whether null is fatal. */
export async function httpJson<T>(url: string, init?: RequestInit, timeoutMs = 2500): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/** Resolve a binary on PATH. Returns the absolute path or null. */
export async function commandExists(bin: string): Promise<string | null> {
  const cmd = platform() === 'win32' ? ['where', bin] : ['which', bin];
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
    const exit = await proc.exited;
    if (exit !== 0) return null;
    const out = (await new Response(proc.stdout).text()).trim();
    return out.split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

/** Locate a system Chromium/Chrome/Edge install. Returns absolute path or null. */
export async function detectChromium(): Promise<string | null> {
  const os = platform();

  if (os === 'win32') {
    const winPaths = [
      `${process.env['PROGRAMFILES']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['LOCALAPPDATA']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES']}\\Chromium\\Application\\chrome.exe`,
      `${process.env['LOCALAPPDATA']}\\Chromium\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env['PROGRAMFILES']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ];
    for (const p of winPaths) {
      if (p && existsSync(p)) return p;
    }
    return commandExists('chrome');
  }

  for (const bin of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    const found = await commandExists(bin);
    if (found) return found;
  }
  return null;
}

// ── Service-specific convenience probes ──────────────────────────────

export interface ServiceProbe extends ProbeResult {
  service: string;
}

export async function probeOllama(baseUrl = 'http://localhost:11434'): Promise<ServiceProbe> {
  const r = await httpReachable(`${baseUrl}/api/tags`, 2000);
  return { service: 'ollama', ...r };
}

export async function probeLiteLLM(baseUrl = 'http://localhost:4000'): Promise<ServiceProbe> {
  const r = await httpReachable(`${baseUrl}/health`, 2000);
  return { service: 'litellm', ...r };
}

export async function probePostgres(host = 'localhost', port = 5432): Promise<ServiceProbe> {
  const r = await tcpReachable(host, port, 1500);
  return { service: 'postgres', ...r };
}

export async function probeRedis(host = 'localhost', port = 6379): Promise<ServiceProbe> {
  const r = await tcpReachable(host, port, 1500);
  return { service: 'redis', ...r };
}

/** Run all common service probes in parallel — used by setup auto-detect. */
export async function probeAllServices(opts?: {
  ollamaUrl?: string;
  litellmUrl?: string;
  postgresHost?: string;
  postgresPort?: number;
  redisHost?: string;
  redisPort?: number;
}): Promise<Record<string, ServiceProbe>> {
  const [ollama, litellm, postgres, redis] = await Promise.all([
    probeOllama(opts?.ollamaUrl),
    probeLiteLLM(opts?.litellmUrl),
    probePostgres(opts?.postgresHost, opts?.postgresPort),
    probeRedis(opts?.redisHost, opts?.redisPort),
  ]);
  return { ollama, litellm, postgres, redis };
}
