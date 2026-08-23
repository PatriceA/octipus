#!/usr/bin/env tsx
/**
 * `octi doctor` — environment health check. Reports what is wired
 * and what is missing so a new user knows exactly what to fix.
 *
 * Output:
 *   - plain-text by default (human-readable, color-coded)
 *   - JSON with `--json` (machine-readable for scripts)
 *
 * Exit codes:
 *   0  all critical checks passed
 *   1  one or more critical checks failed
 *   2  invalid arguments
 */

import { existsSync, readFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join, resolve } from 'path';
import {
  tcpReachable as tcpProbe,
  httpReachable as httpProbe,
} from '../src/setup/probes';
import { spawnProcess } from '@/utils/proc';

// ── Types ──────────────────────────────────────────────────────────

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** True if a failure should make the overall doctor run fail. */
  critical: boolean;
  /** Suggestion for the user when status != 'ok'. */
  hint?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: CheckResult[];
  summary: { ok: number; warn: number; fail: number };
}

// ── Probes ─────────────────────────────────────────────────────────
// Thin boolean adapters around the shared probe helpers so the rest
// of doctor.ts stays unchanged. ProbeResult carries detail/latency
// for future reporting; doctor only cares about reachability today.

async function tcpReachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return (await tcpProbe(host, port, timeoutMs)).ok;
}

async function httpReachable(url: string, timeoutMs = 2000): Promise<boolean> {
  return (await httpProbe(url, timeoutMs)).ok;
}

// ── Individual checks ──────────────────────────────────────────────

export async function checkNodeRuntime(): Promise<CheckResult> {
  // It read `process.versions.node` and called it Bun, against a `>= 1.1`
  // floor every Node release passes — so the preflight printed "Bun 26.2.0" and
  // could not fail. `engines.node` in package.json is the real requirement.
  const version = process.versions.node;
  const [major, minor] = version.split('.').map(Number);
  const ok = major > 24 || (major === 24 && minor >= 9);
  return {
    name: 'Node runtime',
    status: ok ? 'ok' : 'fail',
    detail: `Node ${version}`,
    critical: true,
    hint: ok ? undefined : 'Octipus requires Node ≥ 24.9 (package.json engines). Upgrade: https://nodejs.org',
  };
}

export async function checkEnvFile(projectDir: string): Promise<CheckResult> {
  const envPath = join(projectDir, '.env');
  if (!existsSync(envPath)) {
    return {
      name: 'Bootstrap .env',
      status: 'fail',
      detail: '.env not found',
      critical: true,
      hint: 'Run `npm run setup` (or `octi init`) to generate one.',
    };
  }
  const text = readFileSync(envPath, 'utf-8');
  const required = ['MASTER_KEY', 'JWT_SECRET', 'SESSION_SECRET'];
  const missing = required.filter(key => !new RegExp(`^${key}=.+`, 'm').test(text));
  if (missing.length > 0) {
    return {
      name: 'Bootstrap .env',
      status: 'fail',
      detail: `Missing required keys: ${missing.join(', ')}`,
      critical: true,
      hint: 'Re-run `npm run setup` — security keys are auto-generated.',
    };
  }
  return { name: 'Bootstrap .env', status: 'ok', detail: 'present, all required keys set', critical: true };
}

export async function checkStorageMode(projectDir: string): Promise<CheckResult> {
  const envPath = join(projectDir, '.env');
  if (!existsSync(envPath)) {
    return { name: 'Storage mode', status: 'warn', detail: 'unknown (.env missing)', critical: false };
  }
  const text = readFileSync(envPath, 'utf-8');
  const mode = text.match(/^STORAGE_MODE=(\w+)/m)?.[1] || 'external';
  if (mode === 'embedded') {
    const dataDir = text.match(/^DATA_DIR=(.+)/m)?.[1]?.trim()
      || join(homedir(), '.octipus', 'data');
    return {
      name: 'Storage mode',
      status: 'ok',
      detail: `embedded (PGlite, ${dataDir})`,
      critical: false,
    };
  }
  // external — verify Postgres + Redis
  const dbUrl = text.match(/^DATABASE_URL=(.+)/m)?.[1]?.trim() || '';
  const redisUrl = text.match(/^REDIS_URL=(.+)/m)?.[1]?.trim() || '';
  return {
    name: 'Storage mode',
    status: dbUrl ? 'ok' : 'warn',
    detail: `external (db: ${dbUrl ? 'set' : 'unset'}, redis: ${redisUrl ? 'set' : 'unset'})`,
    critical: false,
    hint: dbUrl ? undefined : 'External mode needs DATABASE_URL — switch to embedded or set the URL.',
  };
}

export async function checkOllama(): Promise<CheckResult> {
  const url = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const reachable = await httpReachable(`${url}/api/tags`);
  if (!reachable) {
    return {
      name: 'Ollama',
      status: 'warn',
      detail: `not reachable at ${url}`,
      critical: false,
      hint: 'Optional — install from https://ollama.com if you want local models.',
    };
  }
  try {
    const res = await fetch(`${url}/api/tags`);
    const data = await res.json() as { models?: Array<{ name: string }> };
    const count = data.models?.length ?? 0;
    if (count === 0) {
      return {
        name: 'Ollama',
        status: 'warn',
        detail: `reachable at ${url}, no models pulled`,
        critical: false,
        hint: 'Run `ollama pull llama3.2:3b` for a small default model.',
      };
    }
    return {
      name: 'Ollama',
      status: 'ok',
      detail: `reachable at ${url}, ${count} model${count === 1 ? '' : 's'}`,
      critical: false,
    };
  } catch (err) {
    return {
      name: 'Ollama',
      status: 'warn',
      detail: `probe failed: ${(err as Error).message}`,
      critical: false,
    };
  }
}

export async function checkLiteLLM(): Promise<CheckResult> {
  // Match the env vars the rest of the codebase actually reads —
  // `src/config/legacy-loader.ts` reads LITELLM_URL first then
  // LITELLM_PROXY_URL. Doctor used to read LITELLM_BASE_URL which is
  // not set anywhere, so it always reported "not configured" even on
  // installs that DO have LiteLLM running.
  const url = process.env.LITELLM_URL
    || process.env.LITELLM_PROXY_URL
    || process.env.LITELLM_BASE_URL;
  if (!url) {
    return { name: 'LiteLLM proxy', status: 'warn', detail: 'not configured', critical: false };
  }
  const reachable = await httpReachable(`${url}/health`);
  return {
    name: 'LiteLLM proxy',
    status: reachable ? 'ok' : 'warn',
    detail: reachable ? `reachable at ${url}` : `unreachable at ${url}`,
    critical: false,
    hint: reachable ? undefined : 'Start the LiteLLM proxy or update LITELLM_URL.',
  };
}

export async function checkBasePersona(projectDir: string): Promise<CheckResult> {
  const personaPath = join(projectDir, 'personas', 'octipus.yaml');
  if (!existsSync(personaPath)) {
    return {
      name: 'Base persona',
      status: 'fail',
      detail: 'personas/octipus.yaml missing',
      critical: true,
      hint: 'The base persona is required — restore from the repo (`git checkout personas/octipus.yaml`).',
    };
  }
  try {
    const { loadPersonaFile } = await import('../src/core/personas/loader');
    const p = await loadPersonaFile(personaPath);
    return {
      name: 'Base persona',
      status: 'ok',
      detail: `${p.name} (${p.id}, tone=${p.tone})`,
      critical: true,
    };
  } catch (err) {
    return {
      name: 'Base persona',
      status: 'fail',
      detail: `parse error: ${(err as Error).message}`,
      critical: true,
      hint: 'Check personas/octipus.yaml for syntax errors.',
    };
  }
}

export async function checkPostgres(): Promise<CheckResult> {
  // Only check if storage mode is external
  const mode = process.env.STORAGE_MODE || 'external';
  if (mode === 'embedded') {
    return { name: 'PostgreSQL', status: 'ok', detail: 'embedded mode, not required', critical: false };
  }
  const reachable = await tcpReachable('localhost', 5432);
  return {
    name: 'PostgreSQL',
    status: reachable ? 'ok' : 'warn',
    detail: reachable ? 'reachable on localhost:5432' : 'not reachable on localhost:5432',
    critical: false,
    hint: reachable ? undefined : 'Start PostgreSQL or switch to STORAGE_MODE=embedded.',
  };
}

export async function checkRedis(): Promise<CheckResult> {
  const mode = process.env.STORAGE_MODE || 'external';
  if (mode === 'embedded') {
    return { name: 'Valkey/Redis', status: 'ok', detail: 'embedded mode, not required', critical: false };
  }
  const reachable = await tcpReachable('localhost', 6379);
  return {
    name: 'Valkey/Redis',
    status: reachable ? 'ok' : 'warn',
    detail: reachable ? 'reachable on localhost:6379' : 'not reachable on localhost:6379',
    critical: false,
    hint: reachable ? undefined : 'Start Valkey/Redis or switch to STORAGE_MODE=embedded.',
  };
}

export async function checkBackend(): Promise<CheckResult> {
  const port = process.env.API_PORT || '3005';
  const reachable = await httpReachable(`http://localhost:${port}/api/health`, 1500);
  return {
    name: 'Backend',
    status: reachable ? 'ok' : 'warn',
    detail: reachable ? `up on :${port}` : `not running on :${port}`,
    critical: false,
    hint: reachable ? undefined : 'Run `octi start` or `npm run dev` to launch.',
  };
}

export async function checkOctipusHome(): Promise<CheckResult> {
  const dir = join(homedir(), '.octipus');
  if (!existsSync(dir)) {
    return {
      name: 'State directory',
      status: 'warn',
      detail: `${dir} does not exist`,
      critical: false,
      hint: 'Will be created on first `octi start` — no action needed.',
    };
  }
  return { name: 'State directory', status: 'ok', detail: dir, critical: false };
}

export async function checkVaultKeys(projectDir: string): Promise<CheckResult> {
  const envPath = join(projectDir, '.env');
  if (!existsSync(envPath)) {
    return { name: 'Vault keys', status: 'warn', detail: '.env not found', critical: false };
  }
  const text = readFileSync(envPath, 'utf-8');
  const masterKey = text.match(/^MASTER_KEY=(.+)/m)?.[1]?.trim() || '';
  // base64 32 bytes ≈ 44 chars; tolerate slight variation.
  const looksValid = masterKey.length >= 40 && masterKey.length <= 60;
  return {
    name: 'Vault keys',
    status: looksValid ? 'ok' : 'fail',
    detail: looksValid ? 'MASTER_KEY present and well-formed' : `MASTER_KEY length ${masterKey.length} (expected ~44)`,
    critical: true,
    hint: looksValid ? undefined : 'Re-run `npm run setup` to regenerate. Existing vault entries become unrecoverable if the key is rotated.',
  };
}

export async function checkMcpServerBuild(projectDir: string): Promise<CheckResult> {
  const distEntry = join(projectDir, 'mcp-server', 'dist', 'index.js');
  if (!existsSync(distEntry)) {
    return {
      name: 'MCP server',
      status: 'warn',
      detail: 'mcp-server/dist/index.js missing',
      critical: false,
      hint: 'Run `cd mcp-server && npm run build` if you want to expose Octipus tools via MCP.',
    };
  }
  return { name: 'MCP server', status: 'ok', detail: 'built', critical: false };
}

export async function checkBrowserExtension(): Promise<CheckResult> {
  // Two ways the extension can be "present":
  //   1. The unpacked extension dir is installed under ~/.octipus
  //      (what `npm run setup` copies).
  //   2. The backend is up AND its /ws/browser-bridge has a live
  //      connection from a browser that loaded the extension. This
  //      second path matters because users installing the extension
  //      directly from the Chrome / Firefox store never have a copy
  //      under ~/.octipus, which used to surface as "not installed".
  const dir = join(homedir(), '.octipus', 'browser-extension');
  const hasDir = existsSync(dir);

  let bridgeConnected = false;
  try {
    const port = process.env.PORT || process.env.OCTIPUS_PORT || '3005';
    const res = await fetch(`http://localhost:${port}/api/health/browser-bridge`, {
      signal: AbortSignal.timeout(750),
    });
    if (res.ok) {
      const body = await res.json().catch(() => null) as { connected?: boolean } | null;
      bridgeConnected = body?.connected === true;
    }
  } catch {
    // Backend not up or endpoint missing — fall back to the dir check.
  }

  if (bridgeConnected) {
    return {
      name: 'Browser extension',
      status: 'ok',
      detail: hasDir ? `connected (dir: ${dir})` : 'connected (extension loaded from store)',
      critical: false,
    };
  }
  if (hasDir) {
    return { name: 'Browser extension', status: 'ok', detail: `installed at ${dir}`, critical: false };
  }
  return {
    name: 'Browser extension',
    status: 'warn',
    detail: 'not installed or not connected',
    critical: false,
    hint: 'Optional — `npm run setup` can copy a local copy; or load the extension from the Chrome/Firefox store. Needed only for browser-handoff tools.',
  };
}

export async function checkLogSanity(): Promise<CheckResult> {
  const logFile = join(homedir(), '.octipus', 'backend.log');
  if (!existsSync(logFile)) {
    return { name: 'Backend logs', status: 'warn', detail: 'no log yet (backend never started?)', critical: false };
  }
  try {
    const { statSync } = await import('fs');
    const stats = statSync(logFile);
    const sizeMb = stats.size / (1024 * 1024);
    if (sizeMb > 500) {
      return {
        name: 'Backend logs',
        status: 'warn',
        detail: `${logFile} is ${sizeMb.toFixed(0)}MB — consider rotation`,
        critical: false,
      };
    }
    return { name: 'Backend logs', status: 'ok', detail: `${sizeMb.toFixed(1)}MB`, critical: false };
  } catch {
    return { name: 'Backend logs', status: 'warn', detail: 'stat failed', critical: false };
  }
}

export async function checkDiskSpace(): Promise<CheckResult> {
  try {
    const home = homedir();
    const proc = spawnProcess(['df', '-k', home], { stdout: 'pipe', stderr: 'pipe' });
    if (await proc.exited !== 0) {
      return { name: 'Disk space', status: 'warn', detail: 'df probe failed', critical: false };
    }
    const text = await new Response(proc.stdout).text();
    // Second line, 4th column is "Available" in 1K blocks on Linux/macOS.
    const cols = text.trim().split('\n')[1]?.split(/\s+/);
    if (!cols || cols.length < 4) {
      return { name: 'Disk space', status: 'warn', detail: 'df output not parseable', critical: false };
    }
    const availKb = Number(cols[3]);
    const availGb = availKb / (1024 * 1024);
    if (availGb < 1) {
      return {
        name: 'Disk space',
        status: 'fail',
        detail: `${availGb.toFixed(2)}GB free in ${home}`,
        critical: false,
        hint: 'Free up space — embedded mode + logs can hit a wall fast under 1GB.',
      };
    }
    if (availGb < 5) {
      return {
        name: 'Disk space',
        status: 'warn',
        detail: `${availGb.toFixed(1)}GB free in ${home}`,
        critical: false,
      };
    }
    return { name: 'Disk space', status: 'ok', detail: `${availGb.toFixed(1)}GB free`, critical: false };
  } catch {
    // Probe not available (Windows); not critical.
    return { name: 'Disk space', status: 'warn', detail: 'df not available on this platform', critical: false };
  }
}

// ── Runner ─────────────────────────────────────────────────────────

/**
 * Pull the live capabilities table from the backend. We fall back to a
 * `warn` row when the backend isn't up — the table only exists once
 * migrations have run. This intentionally does NOT re-probe locally:
 * the backend is the source of truth, and re-probing here would let
 * doctor and orchestrator drift apart.
 */
export async function checkCapabilities(): Promise<CheckResult> {
  const port = process.env.API_PORT || '3005';
  try {
    const res = await fetch(`http://localhost:${port}/api/capabilities`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as Array<{ toolId: string; available: boolean; reason: string | null }>;
    if (rows.length === 0) {
      return { name: 'Capabilities', status: 'warn', detail: 'no rows — backend probed but registry empty?', critical: false };
    }
    const installed = rows.filter((r) => r.available).map((r) => r.toolId);
    const missing = rows.filter((r) => !r.available).map((r) => r.toolId);
    if (missing.length === 0) {
      return { name: 'Capabilities', status: 'ok', detail: `all installed: ${installed.join(', ')}`, critical: false };
    }
    return {
      name: 'Capabilities',
      status: 'warn',
      detail: `installed: ${installed.join(', ') || '(none)'} · missing: ${missing.join(', ')}`,
      critical: false,
      hint: `Install missing: ${missing.map((m) => `octi capabilities install ${m}`).join(' · ')}`,
    };
  } catch (err) {
    return {
      name: 'Capabilities',
      status: 'warn',
      detail: `backend unreachable (${(err as Error).message}) — cannot read capability state`,
      critical: false,
      hint: 'Start the backend (`octi start`) to populate /api/capabilities.',
    };
  }
}

export async function runDoctor(projectDir: string): Promise<DoctorReport> {
  const checks = await Promise.all([
    checkNodeRuntime(),
    checkEnvFile(projectDir),
    checkVaultKeys(projectDir),
    checkStorageMode(projectDir),
    checkBasePersona(projectDir),
    checkOctipusHome(),
    checkOllama(),
    checkLiteLLM(),
    checkPostgres(),
    checkRedis(),
    checkBackend(),
    checkCapabilities(),
    checkMcpServerBuild(projectDir),
    checkBrowserExtension(),
    checkLogSanity(),
    checkDiskSpace(),
  ]);

  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) summary[c.status]++;

  const criticalFailed = checks.some(c => c.critical && c.status === 'fail');
  return { ok: !criticalFailed, checks, summary };
}

// ── Renderers ──────────────────────────────────────────────────────

function color(s: string, code: string): string {
  return process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
}

const STATUS_GLYPH: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗' };
const STATUS_COLOR: Record<CheckStatus, string> = { ok: '32', warn: '33', fail: '31' };

function renderText(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(color('Octipus doctor', '1'));
  lines.push('');
  for (const c of report.checks) {
    const glyph = color(STATUS_GLYPH[c.status], STATUS_COLOR[c.status]);
    lines.push(`  ${glyph} ${c.name.padEnd(20)} ${c.detail}`);
    if (c.hint && c.status !== 'ok') {
      lines.push(`      ${color('hint:', '2')} ${c.hint}`);
    }
  }
  lines.push('');
  const { ok, warn, fail } = report.summary;
  const summary = `${color(`${ok} ok`, '32')}, ${color(`${warn} warn`, '33')}, ${color(`${fail} fail`, '31')}`;
  lines.push(`Summary: ${summary}`);
  if (!report.ok) {
    lines.push('');
    lines.push(color('One or more critical checks failed.', '31'));
  }
  return lines.join('\n');
}

function renderJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

// ── Entrypoint ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const helpMode = args.includes('--help') || args.includes('-h');
  if (helpMode) {
    console.log('Usage: octi doctor [--json]');
    console.log('  --json    Output machine-readable JSON instead of human-readable text.');
    process.exit(0);
  }
  // Allow unknown args to be passed through as long as they start with --
  for (const a of args) {
    if (a !== '--json' && a.startsWith('--')) continue;
    if (a !== '--json' && !a.startsWith('--')) {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }

  const projectDir = resolve(import.meta.dirname, '..');
  const report = await runDoctor(projectDir);
  console.log(jsonMode ? renderJson(report) : renderText(report));
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
