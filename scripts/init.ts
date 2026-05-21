#!/usr/bin/env bun
/**
 * `octi init` — pi-tui interactive setup wizard.
 *
 * Replaces the inquirer-based `scripts/setup.ts` for capable
 * terminals. The binary dispatcher (`bin/octi.ts`) picks this when
 * stdin/stdout are TTYs; otherwise it falls back to setup.ts.
 *
 * Steps:
 *   1. Welcome banner
 *   2. Service auto-detection (Ollama, LiteLLM, Postgres, Redis)
 *   3. Storage mode (embedded / external)
 *   4. LLM provider (Ollama → LiteLLM → direct, never Voyage)
 *   5. Model selection (depends on provider)
 *   6. API key (when needed)
 *   7. Summary + write .env
 *
 * All choices land in the same .env keys as setup.ts, so
 * bootstrapDefaultModel picks them up on first boot identically.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
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

// ── Utilities ──────────────────────────────────────────────────────

function generateSecureKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
}

async function tcpReachable(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const sock = await Bun.connect({
      hostname: host,
      port,
      socket: { data() {}, open(s) { s.end(); }, error() {} },
    }).catch(() => null);
    clearTimeout(timer);
    return sock !== null;
  } catch {
    return false;
  }
}

async function httpJson<T>(url: string, init?: RequestInit, timeoutMs = 2500): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

// ── pi-tui theme (matches the chat shell) ──────────────────────────

const SELECT_THEME = {
  selectedPrefix: (t: string) => `\x1b[36m${t}\x1b[0m`,
  selectedText: (t: string) => `\x1b[1;36m${t}\x1b[0m`,
  description: (t: string) => `\x1b[90m${t}\x1b[0m`,
  scrollInfo: (t: string) => `\x1b[90m${t}\x1b[0m`,
  noMatch: (t: string) => `\x1b[33m${t}\x1b[0m`,
};

// ── Step primitives ────────────────────────────────────────────────

interface WizardContext {
  tui: TUI;
  body: Container;
  terminal: ProcessTerminal;
}

/**
 * Render a sequence of components below a sticky banner. Returns a
 * function that swaps the current step out so the next can be drawn.
 */
function mountStep(ctx: WizardContext, title: string, components: { render(width: number): string[] }[]): () => void {
  // Remove previous step children, keep the banner.
  while (ctx.body.children.length > 1) ctx.body.removeChild(ctx.body.children[1]);
  ctx.body.addChild(new Spacer(1));
  ctx.body.addChild(new Text(`\x1b[1;36m▸ ${title}\x1b[0m`));
  ctx.body.addChild(new Spacer(1));
  for (const c of components) {
    ctx.body.addChild(c as Parameters<typeof ctx.body.addChild>[0]);
  }
  ctx.tui.requestRender();
  // Cleanup: caller invokes this before mounting the next step.
  return () => { /* mounted children are reset by the next mountStep call */ };
}

function selectStep<T extends string>(
  ctx: WizardContext,
  title: string,
  items: Array<{ value: T; label: string; description?: string }>,
  defaultValue?: T,
): Promise<T> {
  return new Promise((resolveValue) => {
    const list = new SelectList(items as SelectItem[], 12, SELECT_THEME);
    if (defaultValue) {
      const idx = items.findIndex(i => i.value === defaultValue);
      if (idx >= 0) list.setSelectedIndex(idx);
    }
    const hint = new Text('\x1b[90m  ↑/↓ to navigate · Enter to select · Esc to skip\x1b[0m');
    mountStep(ctx, title, [list, new Spacer(1), hint]);
    ctx.tui.setFocus(list as never);
    list.onSelect = (item) => {
      resolveValue(item.value as T);
    };
    list.onCancel = () => {
      resolveValue((defaultValue ?? items[0].value) as T);
    };
  });
}

function textStep(
  ctx: WizardContext,
  title: string,
  prompt: string,
  defaultValue = '',
): Promise<string> {
  return new Promise((resolveValue) => {
    const input = new Input();
    input.setValue(defaultValue);
    const promptText = new Text(`\x1b[90m${prompt}\x1b[0m`);
    const hint = new Text('\x1b[90m  Enter to confirm · Esc for default\x1b[0m');
    mountStep(ctx, title, [promptText, new Spacer(1), input, new Spacer(1), hint]);
    ctx.tui.setFocus(input);
    input.onSubmit = (v) => resolveValue(v || defaultValue);
    input.onEscape = () => resolveValue(defaultValue);
  });
}

function infoStep(ctx: WizardContext, title: string, lines: string[]): Promise<void> {
  return new Promise((resolveStep) => {
    const text = new Text(lines.join('\n'));
    const hint = new Text('\x1b[90m  Press Enter to continue · Ctrl+C to abort\x1b[0m');
    mountStep(ctx, title, [text, new Spacer(1), hint]);
    const off = ctx.tui.addInputListener((data) => {
      // Enter or space advances; Ctrl+C exits.
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

// ── Wizard ────────────────────────────────────────────────────────

interface InitResult {
  storageMode: 'embedded' | 'external';
  databaseUrl: string;
  redisUrl: string;
  dataDir: string;
  port: string;
  host: string;
  bootstrapProvider: string;
  bootstrapModel: string;
  bootstrapApiKey: string;
  bootstrapBaseUrl: string;
}

async function runWizard(ctx: WizardContext): Promise<InitResult | null> {
  // ── Welcome ─────────────────────────────────────────────────
  await infoStep(ctx, 'Welcome', [
    '\x1b[1mOctipus init\x1b[0m — one nervous system, eight arms.',
    '',
    'This wizard configures the bootstrap .env file. Everything else',
    'lives in DB settings after first boot.',
    '',
    'You can re-run this at any time with `octi init`.',
  ]);

  // ── Auto-detect ─────────────────────────────────────────────
  const detected = {
    ollama: await tcpReachable('localhost', 11434),
    postgres: await tcpReachable('localhost', 5432),
    redis: await tcpReachable('localhost', 6379),
  };
  await infoStep(ctx, 'Detected services', [
    detected.ollama ? '\x1b[32m  ✓ Ollama       (localhost:11434)\x1b[0m' : '\x1b[90m  · Ollama       not running\x1b[0m',
    detected.postgres ? '\x1b[32m  ✓ PostgreSQL   (localhost:5432)\x1b[0m' : '\x1b[90m  · PostgreSQL   not running\x1b[0m',
    detected.redis ? '\x1b[32m  ✓ Valkey/Redis (localhost:6379)\x1b[0m' : '\x1b[90m  · Valkey/Redis not running\x1b[0m',
  ]);

  // ── Storage mode ────────────────────────────────────────────
  const storageMode = await selectStep<'embedded' | 'external'>(
    ctx,
    'Storage mode',
    [
      {
        value: 'embedded',
        label: 'Embedded — PGlite + in-memory cache',
        description: 'Zero external deps. Best for personal use / getting started.',
      },
      {
        value: 'external',
        label: 'External — PostgreSQL + Redis',
        description: 'Full production setup. Requires both running.',
      },
    ],
    detected.postgres && detected.redis ? 'external' : 'embedded',
  );

  let databaseUrl = '';
  let redisUrl = '';
  let dataDir = resolve(homedir(), '.octipus', 'data');

  if (storageMode === 'external') {
    databaseUrl = await textStep(ctx, 'Database URL', 'PostgreSQL connection string', 'postgresql://octipus:octipus@localhost:5432/octipus');
    redisUrl = await textStep(ctx, 'Redis URL', 'Valkey/Redis connection string', 'redis://localhost:6379');
  } else {
    dataDir = await textStep(ctx, 'Data directory', 'Where to store the embedded database', dataDir);
  }

  // ── Provider ────────────────────────────────────────────────
  let ollamaModels: string[] = [];
  if (detected.ollama) {
    const tags = await httpJson<{ models?: Array<{ name: string }> }>('http://localhost:11434/api/tags');
    ollamaModels = tags?.models?.map(m => m.name) ?? [];
  }

  type Provider = 'ollama' | 'litellm' | 'openrouter' | 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'cli' | 'skip';
  const providerChoices: Array<{ value: Provider; label: string; description?: string }> = [];
  if (detected.ollama) {
    providerChoices.push({
      value: 'ollama',
      label: `Ollama  (detected${ollamaModels.length > 0 ? `, ${ollamaModels.length} model${ollamaModels.length === 1 ? '' : 's'}` : ', no models pulled'})`,
      description: 'Local inference. Free.',
    });
  }
  providerChoices.push({ value: 'litellm', label: 'LiteLLM proxy', description: 'Existing LiteLLM proxy. We list its models.' });
  providerChoices.push({ value: 'openrouter', label: 'OpenRouter', description: '200+ models, single key. Pay-per-use.' });
  providerChoices.push({ value: 'openai', label: 'OpenAI', description: 'GPT models. Requires API key.' });
  providerChoices.push({ value: 'anthropic', label: 'Anthropic', description: 'Claude models. Requires API key.' });
  providerChoices.push({ value: 'gemini', label: 'Google Gemini', description: 'Gemini models. Requires API key.' });
  providerChoices.push({ value: 'deepseek', label: 'DeepSeek', description: 'DeepSeek models. Requires API key.' });
  providerChoices.push({ value: 'cli', label: 'Claude CLI', description: 'Uses your existing Claude Code auth. No key needed if signed in.' });
  providerChoices.push({ value: 'skip', label: 'Skip — configure later', description: 'Casual chat will show a setup hint until you wire a model.' });

  const provider = await selectStep<Provider>(
    ctx,
    'LLM provider — the base model for every topic',
    providerChoices,
    detected.ollama ? 'ollama' : 'openrouter',
  );

  let bootstrapProvider = '';
  let bootstrapModel = '';
  let bootstrapApiKey = '';
  let bootstrapBaseUrl = '';

  if (provider !== 'skip') {
    bootstrapProvider = provider;

    if (provider === 'ollama') {
      if (ollamaModels.length > 0) {
        bootstrapModel = await selectStep<string>(
          ctx,
          'Choose an Ollama model',
          ollamaModels.map(m => ({ value: m, label: m })),
          ollamaModels[0],
        );
      } else {
        bootstrapModel = await textStep(
          ctx,
          'Ollama model tag (will be pulled later)',
          'e.g. llama3.2:3b — leave blank to pick yourself later',
          'llama3.2:3b',
        );
      }
    } else if (provider === 'litellm') {
      bootstrapBaseUrl = await textStep(ctx, 'LiteLLM proxy URL', 'http(s)://host:port', 'http://localhost:4000');
      bootstrapApiKey = await textStep(ctx, 'LiteLLM API key (optional)', 'Leave blank if the proxy is open', '');
      // Try to list models
      const headers: Record<string, string> = bootstrapApiKey ? { Authorization: `Bearer ${bootstrapApiKey}` } : {};
      const models = await httpJson<{ data?: Array<{ id: string }> }>(bootstrapBaseUrl.replace(/\/$/, '') + '/v1/models', { headers });
      const ids = models?.data?.map(m => m.id) ?? [];
      if (ids.length > 0) {
        bootstrapModel = await selectStep<string>(
          ctx,
          'Choose a LiteLLM model',
          ids.map(id => ({ value: id, label: id })),
          ids[0],
        );
      } else {
        bootstrapModel = await textStep(ctx, 'Model name (LiteLLM)', 'e.g. openai/gpt-4o-mini', 'openai/gpt-4o-mini');
      }
    } else if (provider !== 'cli') {
      bootstrapApiKey = await textStep(ctx, `${provider} API key`, 'Paste the key — it lands in the vault, not .env plaintext', '');
      if (!bootstrapApiKey) {
        bootstrapProvider = '';
        bootstrapModel = '';
      } else {
        const defaults: Record<string, string> = {
          openrouter: 'openai/gpt-4o-mini',
          openai: 'gpt-4o-mini',
          anthropic: 'claude-haiku-4-5-20251001',
          gemini: 'gemini-2.0-flash',
          deepseek: 'deepseek-chat',
        };
        bootstrapModel = await textStep(ctx, `${provider} model id`, '', defaults[provider] || '');
      }
    } else {
      bootstrapModel = await textStep(ctx, 'Claude CLI model id', '', 'claude-sonnet-4-6');
    }
  }

  // ── API server ─────────────────────────────────────────────
  const port = await textStep(ctx, 'API port', 'Backend listens here', '3005');
  const host = await textStep(ctx, 'API host', 'Bind address (127.0.0.1 for local-only)', '127.0.0.1');

  // ── Confirm ────────────────────────────────────────────────
  const summary = [
    `\x1b[1mStorage:\x1b[0m   ${storageMode}${storageMode === 'embedded' ? `  (${dataDir})` : ''}`,
    storageMode === 'external' ? `\x1b[1mDB:\x1b[0m         ${databaseUrl.replace(/:[^:@]*@/, ':***@')}` : '',
    storageMode === 'external' ? `\x1b[1mRedis:\x1b[0m      ${redisUrl}` : '',
    `\x1b[1mProvider:\x1b[0m  ${bootstrapProvider || '(skipped — wire later)'}`,
    bootstrapProvider ? `\x1b[1mModel:\x1b[0m     ${bootstrapModel}` : '',
    `\x1b[1mAPI:\x1b[0m       ${host}:${port}`,
    '',
    'Press Enter to write .env, or Ctrl+C to abort.',
  ].filter(Boolean);
  await infoStep(ctx, 'Summary', summary);

  return {
    storageMode,
    databaseUrl,
    redisUrl,
    dataDir,
    port,
    host,
    bootstrapProvider,
    bootstrapModel,
    bootstrapApiKey,
    bootstrapBaseUrl,
  };
}

// ── .env writer ────────────────────────────────────────────────────

export function buildEnv(result: InitResult, opts: { masterKey: string; jwtSecret: string; sessionSecret: string }): string {
  const lines: string[] = [
    `# Bootstrap Configuration (generated by octi init)`,
    `# ${new Date().toISOString()}`,
    `#`,
    `# All other settings live in DB after first boot.`,
    ``,
    `STORAGE_MODE=${result.storageMode}`,
    ``,
  ];

  if (result.storageMode === 'external') {
    lines.push(
      `DATABASE_URL=${result.databaseUrl}`,
      `REDIS_URL=${result.redisUrl}`,
      ``,
    );
  } else {
    lines.push(
      `DATA_DIR=${result.dataDir}`,
      ``,
    );
  }

  lines.push(
    `MASTER_KEY=${opts.masterKey}`,
    `JWT_SECRET=${opts.jwtSecret}`,
    `SESSION_SECRET=${opts.sessionSecret}`,
    ``,
    `PORT=${result.port}`,
    `HOST=${result.host}`,
    `CORS_ORIGINS=http://localhost:3007`,
    ``,
  );

  if (result.bootstrapProvider) {
    lines.push(
      `# Bootstrap LLM provider — applied on first boot, then DB wins.`,
      `BOOTSTRAP_PROVIDER=${result.bootstrapProvider}`,
      `BOOTSTRAP_MODEL=${result.bootstrapModel}`,
    );
    if (result.bootstrapApiKey) lines.push(`BOOTSTRAP_API_KEY=${result.bootstrapApiKey}`);
    if (result.bootstrapBaseUrl) lines.push(`BOOTSTRAP_BASE_URL=${result.bootstrapBaseUrl}`);
    lines.push(``);
  }

  return lines.join('\n');
}

// ── Entrypoint ────────────────────────────────────────────────────

async function main() {
  if (existsSync('.env')) {
    process.stderr.write('.env already exists. Aborting to avoid overwriting it.\n');
    process.stderr.write('(Delete .env first, or use `bun run setup` which prompts.)\n');
    process.exit(1);
  }

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, false);
  terminal.setTitle('Octipus init');

  let exiting = false;
  const shutdown = async () => {
    if (exiting) return;
    exiting = true;
    try { tui.stop(); } catch { /* ignore */ }
    try { await terminal.drainInput(500, 50); } catch { /* ignore */ }
  };
  process.on('SIGINT', () => { void shutdown().then(() => process.exit(130)); });

  const body = new Container();
  body.addChild(new Text('\x1b[1;36mOctipus\x1b[0m — installing your octopus-machine.'));
  tui.addChild(body);
  tui.start();

  try {
    const result = await runWizard({ tui, body, terminal });
    await shutdown();
    if (!result) {
      process.stderr.write('init: no result. Aborted.\n');
      process.exit(1);
    }
    const env = buildEnv(result, {
      masterKey: generateSecureKey(),
      jwtSecret: generateSecureKey(),
      sessionSecret: generateSecureKey(),
    });
    writeFileSync('.env', env);
    process.stdout.write('\n\x1b[32m✓ Wrote .env\x1b[0m\n\n');
    process.stdout.write('Next:\n');
    process.stdout.write('  octi start         # full stack\n');
    process.stdout.write('  octi tui           # terminal chat\n');
    process.stdout.write('  octi doctor        # check what is wired\n\n');
    process.exit(0);
  } catch (err) {
    await shutdown();
    process.stderr.write(`init failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
