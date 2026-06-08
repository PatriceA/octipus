/**
 * Shared service/binary probes used by the setup wizard, doctor, and
 * the capability service. Single source of truth — no duplicates.
 *
 * All probes return a discriminated result rather than throwing, so
 * callers can decide whether absence is fatal. Probes never swallow
 * unexpected errors silently — they record the reason on the result.
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { arch, cpus, platform, totalmem } from 'node:os';

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

// ── Hardware probe ───────────────────────────────────────────────────
// Best-effort host hardware detection for the `hwfit` model-recommendation
// flow. Shells out to read-only tools that may be absent and degrades
// gracefully (CPU-only) — never throws.

export type GpuVendor = 'nvidia' | 'amd' | 'apple' | 'unknown';

export interface DetectedGpu {
  vendor: GpuVendor;
  name: string;
  /** Usable VRAM in MB. For Apple unified memory this is a RAM-derived budget. */
  vramMB: number;
}

export type HardwareSource = 'nvidia-smi' | 'rocm-smi' | 'sysfs' | 'os' | 'apple-metal';

export interface HardwareProfile {
  gpus: DetectedGpu[];
  /** Sum of usable GPU VRAM across all detected GPUs. 0 ⇒ CPU-only. */
  totalVramMB: number;
  ramMB: number;
  cpu: { cores: number; arch: string };
  platform: NodeJS.Platform;
  /** Provenance of the data, so the UI can say "via nvidia-smi" vs "estimated". */
  source: HardwareSource[];
}

const MB_PER_BYTE = 1 / (1024 * 1024);

/**
 * Run a command and capture stdout, or null on non-zero exit / spawn failure.
 * Read-only by contract — callers only pass query commands.
 */
async function runCapture(cmd: string[], timeoutMs = 4000): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const exit = await proc.exited;
    clearTimeout(timer);
    if (exit !== 0) return null;
    return await new Response(proc.stdout).text();
  } catch {
    return null;
  }
}

/**
 * Parse `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`
 * output. Each line: "NVIDIA GeForce RTX 3060, 12288". `memory.total` is MiB.
 * Pure + exported for unit testing.
 */
export function parseNvidiaSmi(stdout: string): DetectedGpu[] {
  const gpus: DetectedGpu[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const lastComma = trimmed.lastIndexOf(',');
    if (lastComma === -1) continue;
    const name = trimmed.slice(0, lastComma).trim();
    const vramMB = Number.parseInt(trimmed.slice(lastComma + 1).trim(), 10);
    if (!name || !Number.isFinite(vramMB) || vramMB <= 0) continue;
    gpus.push({ vendor: 'nvidia', name, vramMB });
  }
  return gpus;
}

/**
 * Parse total AMD VRAM (MB) out of `rocm-smi --showmeminfo vram` output, in
 * either the `--json` form or the plain-text log form. Sums "VRAM Total Memory
 * (B)" across all reported GPUs. Pure + exported for unit testing. Returns 0
 * when no total can be read.
 *
 * JSON:  {"card0": {"VRAM Total Memory (B)": "17179869184", ...}}
 * Text:  GPU[0] : VRAM Total Memory (B): 17179869184
 */
export function parseRocmSmiVram(stdout: string): number {
  let totalBytes = 0;
  const trimmed = stdout.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, Record<string, string>>;
      for (const card of Object.values(obj)) {
        const raw = card?.['VRAM Total Memory (B)'];
        const bytes = raw ? Number.parseInt(raw, 10) : 0;
        if (Number.isFinite(bytes) && bytes > 0) totalBytes += bytes;
      }
    } catch {
      // fall through to the text parser below
    }
  }
  if (totalBytes === 0) {
    for (const m of stdout.matchAll(/VRAM Total Memory \(B\):\s*(\d+)/g)) {
      const bytes = Number.parseInt(m[1]!, 10);
      if (Number.isFinite(bytes) && bytes > 0) totalBytes += bytes;
    }
  }
  return Math.floor(totalBytes * MB_PER_BYTE);
}

/**
 * Read total VRAM (MB) from the DRM sysfs nodes
 * (`/sys/class/drm/card*\/device/mem_info_vram_total`). Works for AMD GPUs even
 * without rocm-smi installed. Dedups by the resolved PCI device path so a GPU
 * exposed under multiple `cardN` nodes isn't counted twice. Returns 0 on any
 * read failure or when no DRM VRAM node exists (e.g. CPU-only hosts).
 */
function readSysfsVramMB(): number {
  try {
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const entry of readdirSync('/sys/class/drm')) {
      if (!/^card\d+$/.test(entry)) continue; // skip connectors like card0-DP-1
      const deviceDir = `/sys/class/drm/${entry}/device`;
      const vramFile = `${deviceDir}/mem_info_vram_total`;
      if (!existsSync(vramFile)) continue;
      let key: string;
      try {
        key = realpathSync(deviceDir);
      } catch {
        key = deviceDir;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      const bytes = Number.parseInt(readFileSync(vramFile, 'utf8').trim(), 10);
      if (Number.isFinite(bytes) && bytes > 0) totalBytes += bytes;
    }
    return Math.floor(totalBytes * MB_PER_BYTE);
  } catch {
    return 0;
  }
}

/**
 * Detect an AMD GPU and its usable VRAM. Prefers `rocm-smi`'s reported total,
 * falling back to the DRM sysfs node when rocm-smi is absent or reports nothing
 * (e.g. the GPU is in a low-power state). Returns null when there is no evidence
 * of an AMD GPU at all. Never throws.
 */
async function detectAmdGpu(): Promise<{ gpu: DetectedGpu; sources: HardwareSource[] } | null> {
  const sources: HardwareSource[] = [];
  let vramMB = 0;

  if (await commandExists('rocm-smi')) {
    sources.push('rocm-smi');
    const out = await runCapture(['rocm-smi', '--showmeminfo', 'vram', '--json']);
    if (out) vramMB = parseRocmSmiVram(out);
  }

  // Fall back to sysfs (also catches AMD GPUs with no rocm-smi installed).
  if (vramMB === 0) {
    const sysfsMB = readSysfsVramMB();
    if (sysfsMB > 0) {
      vramMB = sysfsMB;
      sources.push('sysfs');
    }
  }

  if (sources.length === 0) return null; // no rocm-smi and no DRM VRAM node ⇒ not AMD
  return { gpu: { vendor: 'amd', name: 'AMD GPU (ROCm)', vramMB }, sources };
}

/**
 * Detect host hardware for model fit-scoring. Never throws; returns a
 * CPU-only profile when no accelerator is found or detection tools are absent.
 */
export async function probeHardware(): Promise<HardwareProfile> {
  const plat = platform();
  const ramMB = Math.floor(totalmem() * MB_PER_BYTE);
  const cpu = { cores: cpus().length, arch: arch() };
  const source: HardwareSource[] = ['os'];
  const gpus: DetectedGpu[] = [];

  // Apple Silicon: unified memory. Treat a fraction of RAM as a usable GPU budget.
  if (plat === 'darwin' && cpu.arch === 'arm64') {
    gpus.push({ vendor: 'apple', name: 'Apple Silicon (unified memory)', vramMB: Math.floor(ramMB * 0.75) });
    source.push('apple-metal');
  } else {
    // NVIDIA — the common discrete-GPU case.
    if (await commandExists('nvidia-smi')) {
      const out = await runCapture([
        'nvidia-smi',
        '--query-gpu=name,memory.total',
        '--format=csv,noheader,nounits',
      ]);
      if (out) {
        const detected = parseNvidiaSmi(out);
        if (detected.length > 0) {
          gpus.push(...detected);
          source.push('nvidia-smi');
        }
      }
    }
    // AMD/ROCm — VRAM via rocm-smi, with a DRM sysfs fallback.
    if (gpus.length === 0) {
      const amd = await detectAmdGpu();
      if (amd) {
        gpus.push(amd.gpu);
        source.push(...amd.sources);
      }
    }
  }

  const totalVramMB = gpus.reduce((sum, g) => sum + g.vramMB, 0);
  return { gpus, totalVramMB, ramMB, cpu, platform: plat, source };
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
