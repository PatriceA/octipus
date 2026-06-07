#!/usr/bin/env bun
/**
 * `octi setup` — the single Octipus setup wizard.
 *
 * Replaces the old inquirer wizard (`scripts/setup.ts`), the bootstrap
 * `scripts/init.ts`, and the web `/setup` page. Walks the user from a
 * clean checkout to a runnable service in one pass:
 *
 *   1. Detect runtime + services (shared probes from src/setup/probes.ts)
 *   2. Storage mode  → writes secrets-only .env
 *   3. Secrets       → auto-generated, written to .env
 *   4. Boot backend  → spawns `bun run src/index.ts`, waits on /api/health
 *   5. Admin account → POST /api/auth/register (first user gets admin grant)
 *   6. Provider      → select from canonical PROVIDERS, key into vault
 *   7. Default model → PATCH /api/settings
 *   8. Capabilities  → probe missing, multiselect-install (Playwright, MCP, …)
 *   9. Mark complete → POST /settings/setup-complete; print next steps
 *
 * Non-interactive mode: pass `--non-interactive` or set CI; the wizard
 * reads OCTIPUS_SETUP_* env vars instead of prompting. Useful for CI
 * and Dockerfile builds.
 *
 *   OCTIPUS_SETUP_STORAGE=embedded|external
 *   OCTIPUS_SETUP_DATA_DIR=~/.octipus/data       (embedded)
 *   OCTIPUS_SETUP_DATABASE_URL=postgres://…      (external)
 *   OCTIPUS_SETUP_REDIS_URL=redis://…            (external)
 *   OCTIPUS_SETUP_API_PORT=3005
 *   OCTIPUS_SETUP_API_HOST=127.0.0.1
 *   OCTIPUS_SETUP_ADMIN_USER, _ADMIN_PASS, _ADMIN_EMAIL
 *   OCTIPUS_SETUP_PROVIDER=openai|anthropic|…
 *   OCTIPUS_SETUP_API_KEY=…
 *   OCTIPUS_SETUP_MODEL=gpt-4o-mini
 *   OCTIPUS_SETUP_INSTALL_CAPS=browser,mcp       (comma-separated)
 *   OCTIPUS_SETUP_RECOMMEND=1                     (scan HW + pull a recommended local model)
 *
 * Remote mode (--remote <url>) skips local .env + backend boot and
 * runs the admin/provider/capability steps against the remote API.
 * Used by Docker: container boots itself, host runs setup against it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable, type Readable } from 'node:stream';
import {
  Container,
  Input,
  ProcessTerminal,
  SelectList,
  type SelectItem,
  Spacer,
  Text,
  TUI,
} from '@mariozechner/pi-tui';
import { httpReachable, probeAllServices } from '@/setup/probes';
import { PROVIDERS, getProvider, type ProviderId } from '@/setup/providers';

// ── Args ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const REMOTE_URL = (() => {
  const i = args.indexOf('--remote');
  return i >= 0 ? args[i + 1] : null;
})();
const NON_INTERACTIVE =
  args.includes('--non-interactive') || !process.stdout.isTTY || !!process.env.CI;

// ── Utilities ──────────────────────────────────────────────────────

function generateSecureKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
}

const SELECT_THEME = {
  selectedPrefix: (t: string) => `\x1b[36m${t}\x1b[0m`,
  selectedText: (t: string) => `\x1b[1;36m${t}\x1b[0m`,
  description: (t: string) => `\x1b[90m${t}\x1b[0m`,
  scrollInfo: (t: string) => `\x1b[90m${t}\x1b[0m`,
  noMatch: (t: string) => `\x1b[33m${t}\x1b[0m`,
};

interface WizardCtx {
  tui: TUI;
  body: Container;
  terminal: ProcessTerminal;
}

function mountStep(ctx: WizardCtx, title: string, components: { render(width: number): string[] }[]): void {
  while (ctx.body.children.length > 1) ctx.body.removeChild(ctx.body.children[1]);
  ctx.body.addChild(new Spacer(1));
  ctx.body.addChild(new Text(`\x1b[1;36m▸ ${title}\x1b[0m`));
  ctx.body.addChild(new Spacer(1));
  for (const c of components) ctx.body.addChild(c as Parameters<typeof ctx.body.addChild>[0]);
  ctx.tui.requestRender();
}

/**
 * Plain-stdout prompt for the post-backend phase, where the pi-tui context
 * has been torn down (see `main`: `ctx = null`). Exported for tests.
 *
 * When `mask` is set, typed characters are NOT echoed: we route readline's
 * output through a gate that drops writes once the prompt has been shown, so
 * secrets (admin password, provider/API keys) never reach the screen or
 * scrollback. The gate works at the stream level rather than poking
 * readline internals, so it behaves the same under Bun and Node.
 */
export function readlinePrompt(
  query: string,
  opts: { mask?: boolean; input?: Readable; output?: Writable } = {},
): Promise<string> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  let muted = false;
  const gate = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) output.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input, output: gate, terminal: true });
  return new Promise((resolveValue) => {
    rl.question(query, (answer) => {
      // The Enter keystroke was swallowed while muted — restore the cursor.
      if (opts.mask) output.write('\n');
      rl.close();
      resolveValue(answer);
    });
    // rl.question has now flushed the prompt through the gate; from here on,
    // suppress the per-keystroke echo for masked input.
    if (opts.mask) muted = true;
  });
}

async function selectStep<T extends string>(
  ctx: WizardCtx | null,
  title: string,
  items: Array<{ value: T; label: string; description?: string }>,
  defaultValue?: T,
): Promise<T> {
  if (!ctx) {
    process.stdout.write(`\n\x1b[1;36m? \x1b[0m\x1b[1m${title}\x1b[0m\n`);
    items.forEach((item, i) => {
      process.stdout.write(`  ${i + 1}) ${item.label}${item.description ? ` \x1b[90m— ${item.description}\x1b[0m` : ''}\n`);
    });
    const defIdx = Math.max(0, defaultValue ? items.findIndex((i) => i.value === defaultValue) : 0);
    const answer = await readlinePrompt(`  \x1b[36mSelection [${defIdx + 1}]:\x1b[0m `);
    const idx = parseInt(answer, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= items.length) {
      return (defaultValue ?? items[0].value) as T;
    }
    return items[idx].value as T;
  }

  return new Promise((resolveValue) => {
    const list = new SelectList(items as SelectItem[], 12, SELECT_THEME);
    if (defaultValue) {
      const idx = items.findIndex((i) => i.value === defaultValue);
      if (idx >= 0) list.setSelectedIndex(idx);
    }
    const hint = new Text('\x1b[90m  ↑/↓ to navigate · Enter to select · Esc to skip\x1b[0m');
    mountStep(ctx, title, [list, new Spacer(1), hint]);
    ctx.tui.setFocus(list as never);
    list.onSelect = (item) => resolveValue(item.value as T);
    list.onCancel = () => resolveValue((defaultValue ?? items[0].value) as T);
  });
}

async function textStep(ctx: WizardCtx | null, title: string, prompt: string, defaultValue = '', mask = false): Promise<string> {
  if (!ctx) {
    const query = `\n\x1b[1;36m? \x1b[0m\x1b[1m${title}\x1b[0m\n  \x1b[90m${prompt}\x1b[0m\n  \x1b[36m›\x1b[0m `;
    const answer = await readlinePrompt(query, { mask });
    return answer || defaultValue;
  }

  return new Promise((resolveValue) => {
    const input = new Input();
    input.setValue(defaultValue);
    if (mask && 'setMaskCharacter' in input) (input as unknown as { setMaskCharacter: (c: string) => void }).setMaskCharacter('•');
    const promptText = new Text(`\x1b[90m${prompt}\x1b[0m`);
    const hint = new Text('\x1b[90m  Enter to confirm · Esc for default\x1b[0m');
    mountStep(ctx, title, [promptText, new Spacer(1), input, new Spacer(1), hint]);
    ctx.tui.setFocus(input);
    input.onSubmit = (v) => resolveValue(v || defaultValue);
    input.onEscape = () => resolveValue(defaultValue);
  });
}

function infoStep(ctx: WizardCtx, title: string, lines: string[]): Promise<void> {
  return new Promise((resolveStep) => {
    const text = new Text(lines.join('\n'));
    const hint = new Text('\x1b[90m  Press Enter to continue · Ctrl+C to abort\x1b[0m');
    mountStep(ctx, title, [text, new Spacer(1), hint]);
    const off = ctx.tui.addInputListener((data) => {
      if (data === '\r' || data === '\n' || data === ' ') {
        off();
        resolveStep();
        return { consume: true };
      }
      if (data === '\x03') {
        process.stderr.write('\nAborted.\n');
        process.exit(130);
      }
      return undefined;
    });
  });
}

// ── .env writer (secrets only) ─────────────────────────────────────

export interface BootstrapConfig {
  storageMode: 'embedded' | 'external';
  databaseUrl: string;
  redisUrl: string;
  dataDir: string;
  apiPort: string;
  apiHost: string;
  bootstrapProvider: string;
  bootstrapModel: string;
  bootstrapApiKey: string;
  bootstrapBaseUrl: string;
}

/**
 * Read MASTER_KEY / JWT_SECRET / SESSION_SECRET back out of an existing .env so
 * a rerun reuses them. Regenerating MASTER_KEY would orphan everything the vault
 * has already encrypted (AES-256-GCM), so on rerun we keep the originals and only
 * re-do the non-secret config. Returns null if the file is missing or any of the
 * three keys is absent (treat as a fresh install — generate new ones).
 */
export function readExistingSecrets(
  path = '.env',
): { masterKey: string; jwtSecret: string; sessionSecret: string } | null {
  if (!existsSync(path)) return null;
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  const masterKey = env.MASTER_KEY;
  const jwtSecret = env.JWT_SECRET;
  const sessionSecret = env.SESSION_SECRET;
  if (!masterKey || !jwtSecret || !sessionSecret) return null;
  return { masterKey, jwtSecret, sessionSecret };
}

export function buildEnv(cfg: BootstrapConfig, secrets: { masterKey: string; jwtSecret: string; sessionSecret: string }): string {
  const lines: string[] = [
    `# Octipus bootstrap — secrets and pre-DB targets only.`,
    `# Everything else lives in the DB after first boot.`,
    `# Generated by \`octi setup\` on ${new Date().toISOString()}.`,
    ``,
    `MASTER_KEY=${secrets.masterKey}`,
    `JWT_SECRET=${secrets.jwtSecret}`,
    `SESSION_SECRET=${secrets.sessionSecret}`,
    ``,
    `STORAGE_MODE=${cfg.storageMode}`,
  ];
  if (cfg.storageMode === 'external') {
    lines.push(`DATABASE_URL=${cfg.databaseUrl}`, `REDIS_URL=${cfg.redisUrl}`);
  } else {
    lines.push(`DATA_DIR=${cfg.dataDir}`);
  }
  lines.push(``, `API_HOST=${cfg.apiHost}`, `API_PORT=${cfg.apiPort}`, ``);
  if (cfg.bootstrapProvider) {
    lines.push(`# One-shot bootstrap; cleared after first boot seeds the DB.`);
    lines.push(`BOOTSTRAP_PROVIDER=${cfg.bootstrapProvider}`);
    lines.push(`BOOTSTRAP_MODEL=${cfg.bootstrapModel}`);
    if (cfg.bootstrapApiKey) lines.push(`BOOTSTRAP_API_KEY=${cfg.bootstrapApiKey}`);
    if (cfg.bootstrapBaseUrl) lines.push(`BOOTSTRAP_BASE_URL=${cfg.bootstrapBaseUrl}`);
    lines.push(``);
  }
  return lines.join('\n');
}

// ── Backend lifecycle ──────────────────────────────────────────────

interface BackendHandle {
  proc: ReturnType<typeof Bun.spawn>;
  url: string;
  shutdown: () => Promise<void>;
}

async function bootBackend(apiHost: string, apiPort: string): Promise<BackendHandle> {
  const url = `http://${apiHost === '0.0.0.0' ? '127.0.0.1' : apiHost}:${apiPort}`;
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts'], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });

  // Drain BOTH pipes continuously from the start. The backend logs to stdout
  // (pino), so a boot crash leaves its real error there, not on stderr — and
  // an undrained pipe can fill its buffer and block the backend mid-boot,
  // masking the failure as a 60s timeout. We accumulate both and surface them.
  let captured = '';
  const drain = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!stream) return;
    const decoder = new TextDecoder();
    for await (const chunk of stream) captured += decoder.decode(chunk, { stream: true });
  };
  const draining = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  const tail = () => captured.trim().slice(-2000) || '(no output captured)';

  // Wait for /api/health (max 60s — first boot runs migrations + seeds).
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const probe = await httpReachable(`${url}/api/health`, 1000);
    if (probe.ok) {
      return {
        proc,
        url,
        shutdown: async () => {
          proc.kill();
          await proc.exited.catch(() => {});
        },
      };
    }
    if (proc.exitCode !== null) {
      await draining.catch(() => {});
      throw new Error(`backend exited before becoming healthy:\n${tail()}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  proc.kill();
  await draining.catch(() => {});
  throw new Error(`backend did not become healthy within 60s:\n${tail()}`);
}

// ── API helpers (cookie-aware) ─────────────────────────────────────

/**
 * Carries the HTTP status and raw body of a failed API call so callers can
 * map it to a friendly message instead of parsing a stringified Error.
 */
export class ApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly bodyText: string,
  ) {
    super(`${method} ${path} → ${status}: ${bodyText}`);
    this.name = 'ApiError';
  }

  /** Best-effort human message: the `{ error }` field of a JSON body, else raw text. */
  get serverMessage(): string {
    try {
      const parsed = JSON.parse(this.bodyText) as { error?: unknown };
      if (typeof parsed.error === 'string') return parsed.error;
    } catch {
      /* body wasn't JSON — fall through to raw text */
    }
    return this.bodyText;
  }
}

class ApiClient {
  private cookie: string | null = null;

  constructor(private baseUrl: string) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookie) headers['Cookie'] = this.cookie;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    if (!res.ok) throw new ApiError(method, path, res.status, await res.text());
    return (await res.json()) as T;
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
}

// ── Pre-backend wizard (.env writing) ──────────────────────────────

async function runPreBackend(ctx: WizardCtx | null): Promise<BootstrapConfig & { secrets: { masterKey: string; jwtSecret: string; sessionSecret: string } }> {
  // Auto-detect services for sensible defaults.
  const services = await probeAllServices();

  let storageMode: 'embedded' | 'external';
  if (NON_INTERACTIVE) {
    storageMode = (process.env.OCTIPUS_SETUP_STORAGE as 'embedded' | 'external') ||
      (services.postgres.ok && services.redis.ok ? 'external' : 'embedded');
  } else if (ctx) {
    await infoStep(ctx, 'Welcome', [
      '\x1b[1mOctipus setup\x1b[0m — one nervous system, many arms.',
      '',
      'This wizard writes a secrets-only .env, boots the backend,',
      'registers your admin account, wires a model provider, and',
      'installs optional capabilities (browser, MCP server, …).',
      '',
      `Detected: ollama=${services.ollama.ok ? '✓' : '·'}  postgres=${services.postgres.ok ? '✓' : '·'}  valkey=${services.redis.ok ? '✓' : '·'}  litellm=${services.litellm.ok ? '✓' : '·'}`,
    ]);
    storageMode = await selectStep<'embedded' | 'external'>(
      ctx,
      'Storage mode',
      [
        { value: 'embedded', label: 'Embedded — PGlite + in-memory cache', description: 'Zero external deps. Best for personal use / getting started.' },
        { value: 'external', label: 'External — PostgreSQL + Valkey', description: 'Full production setup. Requires both running (Valkey or any Redis-compatible server).' },
      ],
      services.postgres.ok && services.redis.ok ? 'external' : 'embedded',
    );
  } else {
    throw new Error('cannot prompt in non-interactive mode without TTY');
  }

  let databaseUrl = '';
  let redisUrl = '';
  let dataDir = resolve(homedir(), '.octipus', 'data');

  if (storageMode === 'external') {
    if (NON_INTERACTIVE) {
      databaseUrl = process.env.OCTIPUS_SETUP_DATABASE_URL || 'postgresql://octipus:octipus@localhost:5432/octipus';
      redisUrl = process.env.OCTIPUS_SETUP_REDIS_URL || 'redis://localhost:6379';
    } else if (ctx) {
      databaseUrl = await textStep(ctx, 'Database URL', 'PostgreSQL connection string', 'postgresql://octipus:octipus@localhost:5432/octipus');
      redisUrl = await textStep(ctx, 'Valkey URL', 'Valkey (or Redis-compatible) connection string', 'redis://localhost:6379');
    }
  } else if (ctx && !NON_INTERACTIVE) {
    dataDir = await textStep(ctx, 'Data directory', 'Where to store the embedded database', dataDir);
  } else {
    dataDir = process.env.OCTIPUS_SETUP_DATA_DIR || dataDir;
  }

  const apiPort = NON_INTERACTIVE
    ? process.env.OCTIPUS_SETUP_API_PORT || '3005'
    : ctx ? await textStep(ctx, 'API port', 'Backend listens here', '3005') : '3005';
  const apiHost = NON_INTERACTIVE
    ? process.env.OCTIPUS_SETUP_API_HOST || '127.0.0.1'
    : ctx ? await textStep(ctx, 'API host', 'Bind address (127.0.0.1 for local-only)', '127.0.0.1') : '127.0.0.1';

  return {
    storageMode,
    databaseUrl,
    redisUrl,
    dataDir,
    apiPort,
    apiHost,
    bootstrapProvider: '',
    bootstrapModel: '',
    bootstrapApiKey: '',
    bootstrapBaseUrl: '',
    secrets: {
      masterKey: generateSecureKey(),
      jwtSecret: generateSecureKey(),
      sessionSecret: generateSecureKey(),
    },
  };
}

// ── Post-backend wizard (admin, provider, default model, caps) ─────

async function pickAdmin(ctx: WizardCtx | null): Promise<{ username: string; email?: string; password: string }> {
  // Email is optional on /api/auth/register via t.Optional — which only
  // accepts the key being ABSENT. An empty string is "present" and fails the
  // format:email check (422), so collapse blank input to undefined and let
  // JSON.stringify drop it from the body entirely.
  if (NON_INTERACTIVE) {
    const username = process.env.OCTIPUS_SETUP_ADMIN_USER;
    const password = process.env.OCTIPUS_SETUP_ADMIN_PASS;
    if (!username || !password) throw new Error('OCTIPUS_SETUP_ADMIN_USER and OCTIPUS_SETUP_ADMIN_PASS required in non-interactive mode');
    return { username, email: process.env.OCTIPUS_SETUP_ADMIN_EMAIL || undefined, password };
  }
  const username = await textStep(ctx, 'Admin account — username', 'You\'ll log in as this user (≥3 chars)', 'admin');
  const email = await textStep(ctx, 'Admin account — email (optional)', 'Leave blank to skip', '');
  const password = await textStep(ctx, 'Admin account — password', 'Min 8 chars, ≥1 upper, ≥1 lower, ≥1 digit', '', true);
  return { username, email: email.trim() || undefined, password };
}

async function pickProvider(ctx: WizardCtx | null): Promise<{ providerId: ProviderId; apiKey: string; model: string; baseUrl: string }> {
  if (NON_INTERACTIVE) {
    const providerId = (process.env.OCTIPUS_SETUP_PROVIDER || 'openai') as ProviderId;
    const def = getProvider(providerId);
    return {
      providerId,
      apiKey: process.env.OCTIPUS_SETUP_API_KEY || '',
      model: process.env.OCTIPUS_SETUP_MODEL || def.defaultModel,
      baseUrl: process.env.OCTIPUS_SETUP_BASE_URL || '',
    };
  }

  // Run live detection so the wizard shows what's already up.
  const probes = await Promise.all(
    PROVIDERS.map(async (p) => ({ p, r: p.detect ? await p.detect() : { ok: false } })),
  );
  const items = probes.map(({ p, r }) => ({
    value: p.id,
    label: r.ok
      ? `${p.label}  \x1b[32m(detected${'modelCount' in r && r.modelCount ? `, ${r.modelCount} models` : ''})\x1b[0m`
      : p.label,
    description: p.description,
  }));
  const providerId = await selectStep<ProviderId>(ctx, 'LLM provider', items, items[0]?.value as ProviderId);
  const def = getProvider(providerId);

  let apiKey = '';
  let baseUrl = '';
  let model = def.defaultModel;

  if (def.id === 'litellm') {
    baseUrl = await textStep(ctx, 'LiteLLM proxy URL', 'http(s)://host:port', 'http://localhost:4000');
    apiKey = await textStep(ctx, 'LiteLLM API key (optional)', 'Leave blank if open', '', true);
  } else if (def.id === 'ollama') {
    // Capture the Ollama URL so it gets persisted (ollama.url) — otherwise the
    // model is seeded but chat has no endpoint to reach and fails with
    // "can't reach Ollama" even though detection found it.
    const detected = process.env.OLLAMA_URL || process.env.OLLAMA_HOST || 'http://localhost:11434';
    baseUrl = await textStep(ctx, 'Ollama URL', 'Where Ollama is running', detected);
  } else if (def.requiresApiKey) {
    apiKey = await textStep(ctx, `${def.label} API key`, 'Stored in the vault, never plaintext after setup', '', true);
  }

  // Try to list live models when the provider supports it.
  const live = def.listModels ? await def.listModels({ baseUrl, apiKey }) : null;
  if (live && live.length > 0) {
    model = await selectStep<string>(
      ctx,
      'Default model',
      live.slice(0, 50).map((m) => ({ value: m, label: m })),
      live.includes(def.defaultModel) ? def.defaultModel : live[0],
    );
  } else {
    model = await textStep(ctx, 'Default model id', '', def.defaultModel);
  }
  return { providerId, apiKey, model, baseUrl };
}

async function pickCapabilities(ctx: WizardCtx | null, missing: string[]): Promise<string[]> {
  if (missing.length === 0) return [];
  if (NON_INTERACTIVE) {
    const env = process.env.OCTIPUS_SETUP_INSTALL_CAPS;
    if (!env) return [];
    if (env === 'all') return missing;
    return env.split(',').map((s) => s.trim()).filter((s) => missing.includes(s));
  }
  // pi-tui doesn't have a multiselect out of the box; we ask once with
  // "all" / "none" / "let me pick one at a time" branching for simplicity.
  const mode = await selectStep<'all' | 'none' | 'pick'>(
    ctx,
    `Optional capabilities — ${missing.length} missing`,
    [
      { value: 'all', label: `Install all (${missing.join(', ')})`, description: 'Recommended — full agent toolset.' },
      { value: 'pick', label: 'Pick one at a time', description: 'Walk through each.' },
      { value: 'none', label: 'Skip all — install later with `octi capabilities install <name>`', description: '' },
    ],
    'all',
  );
  if (mode === 'all') return missing;
  if (mode === 'none') return [];
  const picked: string[] = [];
  for (const cap of missing) {
    const choice = await selectStep<'y' | 'n'>(
      ctx,
      `Install "${cap}"?`,
      [
        { value: 'y', label: 'Yes', description: '' },
        { value: 'n', label: 'No', description: '' },
      ],
      'y',
    );
    if (choice === 'y') picked.push(cap);
  }
  return picked;
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  // Remote-mode short-circuit: skip .env + backend boot, use existing API.
  if (REMOTE_URL) {
    process.stdout.write(`octi setup --remote ${REMOTE_URL}\n`);
    process.stdout.write('(local .env unchanged; configuring remote backend)\n\n');
    await runApiPhase(REMOTE_URL, null);
    return;
  }

  // Rerun-safe: if .env already exists, keep its secrets. Regenerating
  // MASTER_KEY would make everything the vault has encrypted unrecoverable, so
  // we reuse the originals and only re-run the non-secret config below.
  const existingSecrets = readExistingSecrets('.env');
  if (existsSync('.env') && !existingSecrets) {
    process.stderr.write(
      '.env exists but is missing MASTER_KEY/JWT_SECRET/SESSION_SECRET. ' +
        'Back it up and delete it before rerunning so fresh secrets can be generated.\n',
    );
    process.exit(1);
  }
  if (existingSecrets) {
    process.stdout.write('\x1b[2m(reusing existing secrets from .env)\x1b[0m\n');
  }

  // Pre-backend phase: TUI or non-interactive.
  let ctx: WizardCtx | null = null;
  let cfg: BootstrapConfig & { secrets: { masterKey: string; jwtSecret: string; sessionSecret: string } };
  if (NON_INTERACTIVE) {
    cfg = await runPreBackend(null);
  } else {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal, false);
    terminal.setTitle('Octipus setup');
    const body = new Container();
    body.addChild(new Text('\x1b[1;36mOctipus\x1b[0m — installing your octopus-machine.'));
    tui.addChild(body);
    tui.start();
    ctx = { tui, body, terminal };
    process.on('SIGINT', () => {
      try { tui.stop(); } catch {}
      process.exit(130);
    });
    try {
      cfg = await runPreBackend(ctx);
    } finally {
      try { tui.stop(); } catch {}
      try { await terminal.drainInput(500, 50); } catch {}
    }
    ctx = null; // TUI is stopped now; post-backend phase uses plain stdout
  }

  // Preserve the original secrets on a rerun — runPreBackend always generates
  // fresh ones, but reusing the existing MASTER_KEY keeps the vault decryptable.
  if (existingSecrets) cfg.secrets = existingSecrets;

  // Write .env.
  const env = buildEnv(cfg, cfg.secrets);
  writeFileSync('.env', env);
  process.stdout.write('\n\x1b[32m✓ Wrote .env (secrets only — everything else lives in the DB)\x1b[0m\n');

  // Boot backend.
  process.stdout.write('Booting backend (runs migrations + seeds — may take ~30s on first boot)…\n');
  const backend = await bootBackend(cfg.apiHost, cfg.apiPort);
  process.stdout.write(`\x1b[32m✓ Backend healthy at ${backend.url}\x1b[0m\n`);

  try {
    await runApiPhase(backend.url, null);
  } finally {
    process.stdout.write('Shutting down setup backend…\n');
    await backend.shutdown();
  }

  process.stdout.write('\n\x1b[1;32mSetup complete.\x1b[0m\n');
  process.stdout.write('  octi start         # full stack (api + web)\n');
  process.stdout.write('  octi tui           # terminal chat\n');
  process.stdout.write('  octi capabilities  # view installed tools\n\n');
}

/**
 * The post-backend phase. Talks to a running API at `baseUrl` — used
 * for both the local-boot path and `--remote`. `ctx` is null because
 * we run this phase against plain stdout (the TUI was stopped before
 * we spawned the backend so its logs don't tear up the screen).
 */
/** hwfit response shapes (subset; full types live in src/capabilities/hwfit). */
interface RecommendResp {
  hardware?: { gpus: { name: string }[]; totalVramMB: number; ramMB: number; source: string[] };
  scored?: Array<{
    entry: { id: string; topics: string[]; vramMB: number };
    fits: boolean;
    recommended: boolean;
    orchestratorMode?: 'full' | 'lite' | 'router';
    orchestratorModeNote?: string;
  }>;
  error?: string;
}
interface InstallJobResp {
  status: 'pulling' | 'registering' | 'done' | 'error';
  percent: number;
  modelName?: string;
  error?: string;
}

/**
 * Scan hardware and pull a recommended local model. Fully automatic and only
 * acts when OCTIPUS_SETUP_RECOMMEND=1 (good for Docker/CI first-boot) — it picks
 * the top recommended chat/general model that fits and binds it. In any other
 * mode it just points the user at the web "Recommended" panel (the interactive
 * post-backend phase runs on plain stdout without the TUI).
 */
async function maybeRecommendModel(api: ApiClient): Promise<void> {
  if (process.env.OCTIPUS_SETUP_RECOMMEND !== '1') {
    process.stdout.write(
      '\x1b[90m· Tip: open the web Models page for "Recommended for your hardware" to install a local model.\x1b[0m\n',
    );
    return;
  }

  process.stdout.write('Scanning hardware for a recommended local model…\n');
  let rec: RecommendResp;
  try {
    rec = await api.post<RecommendResp>('/api/models/recommend', {});
  } catch (err) {
    process.stdout.write(`\x1b[33m! Hardware scan failed: ${(err as Error).message}\x1b[0m\n`);
    return;
  }
  if (rec.error || !rec.scored?.length) {
    process.stdout.write(`\x1b[33m! No recommendation available${rec.error ? `: ${rec.error}` : ''}.\x1b[0m\n`);
    return;
  }

  // Prefer a recommended chat/general model that fits; fall back to any fitting recommendation.
  const pick =
    rec.scored.find((s) => s.recommended && s.fits && s.entry.topics.some((t) => t === 'chat' || t === 'general')) ??
    rec.scored.find((s) => s.recommended && s.fits) ??
    rec.scored.find((s) => s.fits);
  if (!pick) {
    process.stdout.write('\x1b[33m! No model fits the detected hardware; skipping.\x1b[0m\n');
    return;
  }

  if (pick.orchestratorModeNote) {
    // Tell the user what this model means for how Octipus will run. Mode stays
    // on 'auto' (re-derived live), so swapping the default model later changes
    // this automatically — we only inform here.
    process.stdout.write(`\x1b[90m· As the default, this model runs the orchestrator in ${pick.orchestratorModeNote}.\x1b[0m\n`);
  }

  process.stdout.write(`Pulling ${pick.entry.id} (binding: ${pick.entry.topics.join(', ')})…\n`);
  let job: { jobId?: string; error?: string };
  try {
    job = await api.post<{ jobId?: string; error?: string }>('/api/models/install', {
      id: pick.entry.id,
      bindTopics: pick.entry.topics,
    });
  } catch (err) {
    process.stdout.write(`\x1b[33m! Install failed to start: ${(err as Error).message}\x1b[0m\n`);
    return;
  }
  if (!job.jobId) {
    process.stdout.write(`\x1b[33m! Install failed to start${job.error ? `: ${job.error}` : ''}.\x1b[0m\n`);
    return;
  }

  // Poll until done — pulls can take minutes on first boot.
  for (let i = 0; i < 1800; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    let status: InstallJobResp;
    try {
      status = await api.get<InstallJobResp>(`/api/models/install/${job.jobId}`);
    } catch {
      continue;
    }
    if (status.status === 'done') {
      process.stdout.write(`\x1b[32m✓ Installed ${status.modelName} and bound to ${pick.entry.topics.join(', ')}\x1b[0m\n`);
      return;
    }
    if (status.status === 'error') {
      process.stdout.write(`\x1b[33m! Install failed: ${status.error}\x1b[0m\n`);
      return;
    }
  }
  process.stdout.write('\x1b[33m! Install still running after 30 min; check the Models page.\x1b[0m\n');
}

/**
 * Turn a failed POST /api/auth/register into an actionable message. The raw
 * 422 the backend returns ("Invalid request data") is opaque — map the common
 * status codes to the field the user can actually fix.
 */
export function adminRegisterHint(err: unknown, admin: { username: string; email?: string }): string {
  if (!(err instanceof ApiError)) {
    return `Admin registration failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  let hint: string;
  switch (err.status) {
    case 422:
      // Schema validation: username (3–50 chars) or email format. We already
      // omit a blank email, so a 422 here means a malformed value was entered.
      hint = admin.email
        ? `"${admin.email}" is not a valid email address (leave it blank to skip), and the username must be 3–50 characters`
        : 'the username must be 3–50 characters';
      break;
    case 400:
      // Password complexity — the backend's message is already specific.
      hint = err.serverMessage;
      break;
    case 409:
      hint = 'that username or email is already registered — pick another or log in instead';
      break;
    case 429:
      hint = 'too many registration attempts — wait a few minutes, then rerun setup';
      break;
    default:
      hint = err.serverMessage;
  }
  return `Admin registration failed (HTTP ${err.status}): ${hint}`;
}

async function runApiPhase(baseUrl: string, _ctx: WizardCtx | null): Promise<void> {
  const api = new ApiClient(baseUrl);

  // Admin account. Retry in-place on retryable errors (validation 422 / taken
  // username 409) instead of aborting the whole wizard — a weak password or a
  // taken name shouldn't force the user to restart setup from scratch. In
  // non-interactive mode there's nothing to re-prompt, so fail fast as before.
  for (;;) {
    const admin = await pickAdmin(null);
    process.stdout.write(`Registering admin "${admin.username}"…\n`);
    try {
      await api.post('/api/auth/register', admin);
      process.stdout.write('\x1b[32m✓ Admin registered (first-user admin grant applied)\x1b[0m\n');
      break;
    } catch (err) {
      const retryable = err instanceof ApiError && (err.status === 422 || err.status === 409);
      if (retryable && !NON_INTERACTIVE) {
        process.stdout.write(`\x1b[33m! ${adminRegisterHint(err, admin)}\x1b[0m\n  Let's try that step again.\n\n`);
        continue;
      }
      throw err instanceof ApiError ? new Error(adminRegisterHint(err, admin)) : err;
    }
  }

  // Provider + key.
  const provider = await pickProvider(null);
  if (provider.providerId) {
    process.stdout.write(`Wiring provider "${provider.providerId}"…\n`);
    const def = getProvider(provider.providerId);
    // Build a batch of setting writes. Settings flagged isSecret in
    // SETTINGS_REGISTRY are routed to the vault by the backend handler;
    // we just PUT them through the settings batch endpoint either way.
    const batch: Record<string, unknown> = {
      'orchestrator.defaultModel': provider.model,
    };
    if (def.id === 'ollama') {
      batch['ollama.defaultModel'] = provider.model;
      // Always persist the URL — without it chat can't reach Ollama. Fall back
      // to the standard local endpoint if the user left it blank.
      batch['ollama.url'] = provider.baseUrl || 'http://localhost:11434';
    } else if (def.id === 'litellm') {
      if (provider.baseUrl) batch['litellm.proxyUrl'] = provider.baseUrl;
      if (provider.apiKey) batch['litellm.apiKey'] = provider.apiKey;
    } else if (def.requiresApiKey && provider.apiKey) {
      // Direct providers — there's a vaultKey on the def, but the
      // matching registry entry name uses the `<provider>.apiKey` form
      // (e.g. openrouter.apiKey). Only OpenRouter has an explicit entry
      // today; for the others, PATCH the bootstrap key under the
      // shared `bootstrap.<provider>` path until the registry is
      // extended. Fall back: write straight to the vault via a
      // dedicated provider-key route added in P3.3.
      batch[`${def.id}.apiKey`] = provider.apiKey;
    }
    try {
      await api.put('/api/settings/batch', { settings: batch });
      process.stdout.write(`\x1b[32m✓ Provider configured (default model: ${provider.model})\x1b[0m\n`);
    } catch (err) {
      process.stdout.write(`\x1b[33m! Provider settings partially applied: ${(err as Error).message}\x1b[0m\n`);
    }

    // Register the chosen model in the registry and mark it the default.
    // Settings alone don't create a model_config row, and the orchestrator
    // resolves chat via getDefaultModel() (isDefault + isEnabled) — so without
    // this the selected model is "not registered" and chat has no engine, for
    // EVERY provider. The API key is already in the vault (the settings batch
    // routed <provider>.apiKey → <provider>_api_key, where providers look it
    // up), so the row needs no apiKeyRef; ollama/litellm carry their endpoint.
    const modelName = `${def.id} ${provider.model}`;
    try {
      const res = await api.post<{ error?: string }>('/api/models', {
        name: modelName,
        provider: def.id,
        modelId: provider.model,
        ...(provider.baseUrl ? { endpoint: provider.baseUrl } : {}),
        topics: ['general'],
      });
      // POST returns 200 with {error} on duplicate — a rerun is fine, we still
      // (re)assert it as the default below.
      if (res?.error && !/already exists/i.test(res.error)) {
        process.stdout.write(`\x1b[33m! Model register warning: ${res.error}\x1b[0m\n`);
      }
      await api.post(`/api/models/${encodeURIComponent(modelName)}/default`, {});
      process.stdout.write(`\x1b[32m✓ Registered "${modelName}" as the default model\x1b[0m\n`);
    } catch (err) {
      process.stdout.write(`\x1b[33m! Could not register the model — set it in the Models page: ${(err as Error).message}\x1b[0m\n`);
    }
  }

  // hwfit: optionally scan hardware and pull a recommended local model.
  await maybeRecommendModel(api);

  // Capabilities.
  type CapRow = { toolId: string; available: boolean; reason: string | null; installerKind?: string };
  let caps: CapRow[] = [];
  try {
    caps = await api.get<CapRow[]>('/api/capabilities');
  } catch (err) {
    process.stdout.write(`\x1b[33m! Could not list capabilities: ${(err as Error).message}\x1b[0m\n`);
  }
  // Only offer capabilities that actually have an installer (installerKind
  // 'bun-exec'). The rest (email-processor, gitlab, google-workspace, …) are
  // configured later via credentials/OAuth in the UI — POSTing /install for
  // them just 409s with "No installer registered".
  const missing = caps.filter((c) => !c.available && c.installerKind === 'bun-exec').map((c) => c.toolId);
  const configurable = caps.filter((c) => !c.available && c.installerKind !== 'bun-exec').map((c) => c.toolId);
  if (configurable.length > 0) {
    process.stdout.write(
      `\x1b[2m${configurable.length} capabilities are configured later in the UI (no installer): ${configurable.join(', ')}\x1b[0m\n`,
    );
  }
  const picks = await pickCapabilities(null, missing);
  for (const cap of picks) {
    process.stdout.write(`Installing capability "${cap}"…\n`);
    try {
      const result = await api.post<{ ok: boolean; detail: string }>(`/api/capabilities/${cap}/install`, {});
      process.stdout.write(`  ${result.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[33m!\x1b[0m'} ${result.detail}\n`);
    } catch (err) {
      process.stdout.write(`  \x1b[33m! install failed: ${(err as Error).message}\x1b[0m\n`);
    }
  }

  // Mark setup complete.
  await api.post('/api/settings/setup-complete', {}).catch((err) => {
    process.stdout.write(`\x1b[33m! Could not mark setup complete: ${(err as Error).message}\x1b[0m\n`);
  });
}

if (import.meta.main) {
  await main();
}
