import { describeCliCapabilities } from '@/shared/cli-capabilities';
import { buildChildEnv } from '@/core/cli-child-env';
import { spawn } from 'child_process';
import { getConfig } from '@/config';
import { classifyError } from '@/core/errors/classification';
import { modelLogger } from '@/utils/logger';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import { getQuotaTracker } from '../quota-tracker';
import type { ModelProvider, ProviderHealthStatus, QuotaStatus } from './interface';
import { foldCacheCounters } from './usage';

/**
 * Global cap on concurrently running CLI child processes.
 *
 * Every CLI completion spawns a full agent process (`claude`, `codex`, ...)
 * that can run for minutes. Nothing upstream bounds how many completions are
 * in flight — a background fan-out (doc indexing generating one abstract per
 * chunk) once spawned 40+ `claude` processes in parallel and wedged the host.
 * Cap it here, at the one place every CLI spawn passes through, instead of in
 * every caller.
 *
 * ponytail: single global gate; per-tool gates only if mixing CLIs matters.
 */
const MAX_CONCURRENT_CLI = Math.max(1, Number(process.env.OCTIPUS_CLI_MAX_CONCURRENT ?? 2));
let activeCliRuns = 0;
const cliWaiters: Array<() => void> = [];

export async function acquireCliSlot(): Promise<() => void> {
  if (activeCliRuns >= MAX_CONCURRENT_CLI) {
    modelLogger.debug({ active: activeCliRuns, max: MAX_CONCURRENT_CLI }, 'CLI slot exhausted — queueing');
    await new Promise<void>((resolve) => cliWaiters.push(resolve));
  }
  activeCliRuns++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeCliRuns--;
    cliWaiters.shift()?.();
  };
}

/**
 * Vendor-managed billing info for a CLI tool.
 * Plan tiers, quotas, and what counts toward subscription vs. metered API
 * billing are vendor-controlled and change. We only carry pointers and a
 * non-paraphrased note so the UI can warn users without making promises.
 */
export interface CLIBillingInfo {
  /** Vendor name shown in UI */
  vendor: string;
  /** Free-form plan note ("Pro/Max/Team/Enterprise + API key") */
  planNote: string;
  /** How billing is shaped */
  billingMode: 'subscription' | 'api-key' | 'mixed';
  /** Vendor docs URL for current plans/pricing */
  pricingDocUrl: string;
  /** Vendor docs URL for available models */
  modelsDocUrl: string;
  /** Vendor docs URL for the model-selection flag */
  modelFlagDocUrl: string;
  /** Short caveat shown next to the picker */
  warning: string;
}

/** Configuration for a CLI model tool (exported for CLIAgentWorker) */
export interface CLIToolConfig {
  /** Display name */
  name: string;
  /** Which model names this tool handles */
  modelPatterns: string[];
  /** Path to the CLI binary */
  binaryPath: string;
  /**
   * Which arg-builder / output-parser family this CLI uses in agentic mode
   * (see cli-adapters). Defaults to `name`. Vendors that reuse the Claude Code
   * binary (z.ai GLM, Moonshot Kimi) set this to `'Claude Code'` so dispatch is
   * decoupled from the human-facing `name`.
   */
  adapter?: string;
  /** Build command args for a non-interactive prompt */
  buildArgs: (prompt: string) => string[];
  /** Parse JSON output into CompletionResult */
  parseOutput: (stdout: string, startTime: number) => CompletionResult;
  /** Detect quota exhaustion from stderr/stdout */
  isQuotaError: (output: string) => boolean;
  /** Provider identifier for quota tracking */
  quotaProvider: string;
  /** Vendor-managed billing/usage pointers (surfaced in UI) */
  billingInfo: CLIBillingInfo;
  /** Direct provider whose model catalog drives the picker for this CLI */
  modelProvider: 'anthropic' | 'google' | 'openai' | 'mistral' | 'zai' | 'moonshot';
  /** Flag the CLI uses to select a model (`--model`, `-m`) — for docs only */
  modelFlag: string;
  /**
   * Extra environment variables to inject into the spawned process, resolved at
   * call time (e.g. re-point the `claude` binary at a vendor's Anthropic-
   * compatible endpoint with `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`).
   * Merged over `process.env`.
   */
  buildEnv?: () => Promise<Record<string, string>>;
  /**
   * The CLI emits its entire result as a single blob at process end (e.g. vibe
   * `--output json` writes one JSON array), not incremental stream-json events.
   * When true, the CLIAgentWorker accumulates raw stdout and runs `parseOutput`
   * on the full buffer at close instead of parsing each line as an event.
   */
  bufferOutput?: boolean;
  /** How a managed run hands the CLI its Octipus tools. Default: per-run MCP config. */
  toolBridge?: 'mcp' | 'terminal';
}

// ---- Claude Code CLI ----
const claudeCodeConfig: CLIToolConfig = {
  name: 'Claude Code',
  modelPatterns: ['cli/claude', 'cli/claude-code'],
  binaryPath: 'claude',
  buildArgs: (prompt: string) => ['-p', prompt, '--output-format', 'json'],
  // claude --output-format json returns { result, usage: {...} }; the shared
  // parser sums the SAME resolved input/output values (C18) and falls back to
  // plain text when the payload isn't JSON.
  parseOutput: parseClaudeStyleOutput('cli/claude-code'),
  isQuotaError: (output: string) =>
    /rate.?limit|quota|exceeded|capacity|too many/i.test(output),
  quotaProvider: 'claude-code',
  modelProvider: 'anthropic',
  modelFlag: '--model',
  billingInfo: {
    vendor: 'Anthropic',
    planNote: 'Claude Pro / Max / Team / Enterprise, or Console (API) auth',
    billingMode: 'mixed',
    pricingDocUrl: 'https://www.anthropic.com/pricing',
    modelsDocUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview',
    modelFlagDocUrl: 'https://code.claude.com/docs/en/cli-reference',
    warning: 'Subscription vs. metered-API spillover is vendor-controlled and changes. Consult your Anthropic account for what counts toward your plan.',
  },
};

// ---- Antigravity CLI (agy) ----
// Replaces the Gemini CLI: Google's `gemini` agentic CLI is superseded by
// Antigravity (`agy`), which shares the same ~/.gemini config dir and Gemini
// model backend but has a different, simpler interface — `--print <prompt>`
// emits PLAIN TEXT (no `-o json`/stream-json), `--model` (not `-m`), and
// `--dangerously-skip-permissions` (not `--approval-mode`). The canonical
// pattern is first (new model rows register as `cli/antigravity`); the legacy
// cli/gemini patterns are retained last so existing rows keep routing here.
const antigravityConfig: CLIToolConfig = {
  name: 'Antigravity',
  modelPatterns: ['cli/antigravity', 'cli/agy', 'cli/gemini', 'cli/gemini-cli'],
  binaryPath: 'agy',
  buildArgs: (prompt: string) => ['--dangerously-skip-permissions', '--print', prompt],
  // agy --print returns plain text (no structured envelope). bufferOutput=true
  // routes the whole stdout buffer here at process close.
  parseOutput: (stdout: string, startTime: number): CompletionResult => ({
    content: stdout.trim(),
    finishReason: 'stop',
    // agy reports no token usage in print mode.
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: false },
    model: 'cli/antigravity',
    latencyMs: Date.now() - startTime,
  }),
  isQuotaError: (output: string) =>
    /rate.?limit|quota|exceeded|resource.?exhausted/i.test(output),
  quotaProvider: 'antigravity',
  modelProvider: 'google',
  modelFlag: '--model',
  bufferOutput: true,
  // agy has no per-run MCP config surface; it reaches the bridge via the terminal helper.
  toolBridge: 'terminal',
  billingInfo: {
    vendor: 'Google',
    planNote: 'Google account via `agy` (antigravity) auth in ~/.gemini — same backend as Gemini CLI',
    billingMode: 'mixed',
    pricingDocUrl: 'https://ai.google.dev/pricing',
    modelsDocUrl: 'https://ai.google.dev/gemini-api/docs/models',
    modelFlagDocUrl: 'https://antigravity.google/docs/cli',
    warning: 'Free-tier limits and metered pricing are vendor-controlled. Antigravity manages its own auth and model selection in ~/.gemini.',
  },
};

// ---- Codex CLI ----
const codexCliConfig: CLIToolConfig = {
  name: 'Codex CLI',
  modelPatterns: ['cli/codex', 'cli/codex-cli'],
  binaryPath: 'codex',
  buildArgs: (prompt: string) => ['exec', '--json', prompt],
  parseOutput: (stdout: string, startTime: number): CompletionResult => {
    try {
      // Codex outputs JSONL events. Pull text from item.completed/agent_message
      // and usage totals from turn.completed.
      const lines = stdout.trim().split('\n').filter(Boolean);
      let content = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let sawUsage = false;
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.text) {
            content = event.item.text;
          } else if (event.type === 'message' && event.content) {
            content = event.content;
          } else if (event.type === 'result' && event.text) {
            content = event.text;
          } else if (event.type === 'turn.completed' && event.usage) {
            sawUsage = true;
            inputTokens = event.usage.input_tokens ?? inputTokens;
            outputTokens = event.usage.output_tokens ?? outputTokens;
          }
        } catch {
          // Skip non-JSON lines
        }
      }
      if (!content && lines.length > 0) {
        try {
          const data = JSON.parse(stdout);
          content = data.result || data.content || data.text || stdout.trim();
        } catch {
          content = stdout.trim();
        }
      }
      return {
        content,
        finishReason: 'stop',
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, available: sawUsage },
        model: 'cli/codex-cli',
        latencyMs: Date.now() - startTime,
      };
    } catch {
      return {
        content: stdout.trim(),
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: false },
        model: 'cli/codex-cli',
        latencyMs: Date.now() - startTime,
      };
    }
  },
  isQuotaError: (output: string) =>
    /rate.?limit|quota|exceeded|limit reached/i.test(output),
  quotaProvider: 'codex-cli',
  modelProvider: 'openai',
  modelFlag: '-m',
  billingInfo: {
    vendor: 'OpenAI',
    planNote: 'ChatGPT Plus / Pro / Business / Edu / Enterprise (subscription), or OPENAI_API_KEY (usage-based)',
    billingMode: 'mixed',
    pricingDocUrl: 'https://openai.com/api/pricing/',
    modelsDocUrl: 'https://platform.openai.com/docs/models',
    modelFlagDocUrl: 'https://developers.openai.com/codex/cli/features',
    warning: 'Plan entitlements (incl. Fast mode) are vendor-controlled. ChatGPT-account auth and API-key auth bill differently.',
  },
};

// ---- Mistral Vibe CLI ----
const vibeCliConfig: CLIToolConfig = {
  name: 'Mistral Vibe',
  modelPatterns: ['cli/vibe', 'cli/mistral-vibe'],
  binaryPath: 'vibe',
  // vibe -p runs programmatic mode; --output json emits the full message array
  // at the end. --trust skips the workdir trust prompt; --auto-approve allows
  // tool calls without blocking. Model is selected via vibe's own config
  // (active_model), not a flag — see modelFlag below.
  buildArgs: (prompt: string) => ['-p', prompt, '--output', 'json', '--trust', '--auto-approve'],
  parseOutput: (stdout: string, startTime: number): CompletionResult => {
    try {
      // vibe --output json is a JSON array of all messages. The answer is the
      // last element with role 'assistant'.
      const data = JSON.parse(stdout);
      if (Array.isArray(data)) {
        const assistant = [...data].reverse().find(
          (m) => m && typeof m === 'object' && (m as { role?: string }).role === 'assistant',
        ) as { content?: string } | undefined;
        const content = assistant?.content ?? stdout.trim();
        return {
          content,
          finishReason: 'stop',
          // vibe's JSON carries no usage/cost fields — usage is unknown (0).
          // Budget is enforced via --max-tokens / --max-price instead.
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: false },
          model: 'cli/vibe',
          latencyMs: Date.now() - startTime,
        };
      }
      // Unexpected non-array JSON — fall back to raw text.
      return {
        content: stdout.trim(),
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: false },
        model: 'cli/vibe',
        latencyMs: Date.now() - startTime,
      };
    } catch {
      // Plain-text / partial output — return as-is.
      return {
        content: stdout.trim(),
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: false },
        model: 'cli/vibe',
        latencyMs: Date.now() - startTime,
      };
    }
  },
  isQuotaError: (output: string) =>
    /rate.?limit|quota|exceeded|insufficient|limit reached/i.test(output),
  quotaProvider: 'mistral-vibe',
  // vibe selects its model from its own config (active_model), not a CLI flag,
  // so this is display-only and effectively unused for the picker.
  modelProvider: 'mistral',
  modelFlag: '',
  bufferOutput: true,
  billingInfo: {
    vendor: 'Mistral AI',
    planNote: 'Le Chat Pro / Team (account login via console.mistral.ai — covers Vibe CLI usage), or a metered MISTRAL_API_KEY',
    billingMode: 'mixed',
    pricingDocUrl: 'https://mistral.ai/pricing',
    modelsDocUrl: 'https://docs.mistral.ai/getting-started/models/models_overview/',
    modelFlagDocUrl: 'https://docs.mistral.ai/',
    warning: 'vibe manages its own auth and model selection in ~/.vibe: log in to a Mistral account (subscription, browser auth) or set an API key via `vibe --setup`. Octipus stores no credential for it; subscription vs. metered split is vendor-controlled.',
  },
};

/** Workspace root for one-shot CLI completions (falls back to cwd). */
function resolveWorkspaceRoot(): string {
  try {
    return getConfig().workspace.rootPath || process.cwd();
  } catch {
    return process.cwd();
  }
}

// ---- z.ai (GLM) & Moonshot (Kimi) via the Claude Code binary ----
// Both vendors publish an Anthropic-compatible endpoint, so the existing
// `claude` binary drives them unchanged — we just re-point it via env
// (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN + ANTHROPIC_MODEL). This is the
// documented, reliable path; the standalone `zcode`/`kimi` binaries have no
// non-interactive mode our subprocess wrapper can consume.

/** Resolve a vendor API key: env var first, then the system vault. */
async function resolveCliVendorKey(envVar: string, vaultName: string): Promise<string> {
  if (process.env[envVar]) return process.env[envVar] as string;
  try {
    const { getVault } = await import('@/security/vault');
    return (await getVault().getByName('system', vaultName)) || '';
  } catch (err) {
    modelLogger.warn({ err: (err as Error).message, vaultName }, 'CLI vendor key vault lookup failed');
    return '';
  }
}

/** Parser for the `claude --output-format json` envelope, tagged with a model label. */
function parseClaudeStyleOutput(modelLabel: string) {
  return (stdout: string, startTime: number): CompletionResult => {
    try {
      const data = JSON.parse(stdout);
      const content = typeof data === 'string' ? data : (data.result || data.content || JSON.stringify(data));
      // Nested usage.* overlaid by top-level fields when present (`!= null`),
      // so top-level wins even when it is an explicit 0 — a real zero, not
      // absence. This deliberately differs from the old `data.x || data.usage?.x`
      // read, which let `||` treat a genuine top-level 0 as missing and fall
      // through to the nested value.
      const usageSource = {
        ...(data.usage ?? {}),
        ...(data.input_tokens != null ? { input_tokens: data.input_tokens } : {}),
        ...(data.output_tokens != null ? { output_tokens: data.output_tokens } : {}),
      };
      const { inputTokens, cacheReadTokens, cacheCreationTokens } = foldCacheCounters(usageSource);
      const outputTokens = usageSource.output_tokens || 0;
      return {
        content,
        finishReason: 'stop',
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          available: data.input_tokens != null || data.usage?.input_tokens != null,
          ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
          cacheCreationTokens,
        },
        model: modelLabel,
        latencyMs: Date.now() - startTime,
      };
    } catch {
      return {
        content: stdout.trim(),
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: false },
        model: modelLabel,
        latencyMs: Date.now() - startTime,
      };
    }
  };
}

/** Fields that vary between the Anthropic-compatible vendor CLIs. */
interface AnthropicCompatCliSpec {
  name: string;
  modelPatterns: string[];
  /** Model label stamped on results (e.g. `cli/glm`). */
  modelLabel: string;
  /** Env var overriding the Anthropic-compatible base URL. */
  baseUrlEnv: string;
  defaultBaseUrl: string;
  /** Vendor key env var + vault name. */
  keyEnv: string;
  keyVault: string;
  /** Env var selecting the model + its default. */
  modelEnv: string;
  defaultModel: string;
  quotaProvider: string;
  modelProvider: 'zai' | 'moonshot';
  billingInfo: CLIBillingInfo;
}

/**
 * Build a CLIToolConfig that drives the `claude` binary against a vendor's
 * Anthropic-compatible endpoint. `adapter: 'Claude Code'` reuses Claude's
 * arg-builder + stream parser without coupling dispatch to the display name.
 */
function makeAnthropicCompatCliConfig(spec: AnthropicCompatCliSpec): CLIToolConfig {
  return {
    name: spec.name,
    modelPatterns: spec.modelPatterns,
    binaryPath: 'claude',
    adapter: 'Claude Code',
    buildArgs: (prompt: string) => ['-p', prompt, '--output-format', 'json'],
    parseOutput: parseClaudeStyleOutput(spec.modelLabel),
    buildEnv: async () => {
      const token = await resolveCliVendorKey(spec.keyEnv, spec.keyVault);
      if (!token) {
        throw new Error(`${spec.name}: no API key configured. Set ${spec.keyEnv} or store ${spec.keyVault} in the vault.`);
      }
      return {
        ANTHROPIC_BASE_URL: process.env[spec.baseUrlEnv] || spec.defaultBaseUrl,
        ANTHROPIC_AUTH_TOKEN: token,
        // Clear any real Anthropic key so it can't shadow the vendor auth token.
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_MODEL: process.env[spec.modelEnv] || spec.defaultModel,
        API_TIMEOUT_MS: '3000000',
      };
    },
    isQuotaError: (output: string) => /rate.?limit|quota|exceeded|capacity|too many/i.test(output),
    quotaProvider: spec.quotaProvider,
    modelProvider: spec.modelProvider,
    modelFlag: 'ANTHROPIC_MODEL (env)',
    billingInfo: spec.billingInfo,
  };
}

const glmCliConfig: CLIToolConfig = makeAnthropicCompatCliConfig({
  name: 'Claude Code (z.ai GLM)',
  modelPatterns: ['cli/glm', 'cli/glm-code', 'cli/zai'],
  modelLabel: 'cli/glm',
  baseUrlEnv: 'ZAI_ANTHROPIC_BASE_URL',
  defaultBaseUrl: 'https://api.z.ai/api/anthropic',
  keyEnv: 'ZAI_API_KEY',
  keyVault: 'zai_api_key',
  modelEnv: 'ZAI_CLI_MODEL',
  defaultModel: 'glm-4.6',
  quotaProvider: 'zai-cli',
  modelProvider: 'zai',
  billingInfo: {
    vendor: 'z.ai (Zhipu)',
    planNote: 'GLM Coding Plan or pay-per-token API key',
    billingMode: 'mixed',
    pricingDocUrl: 'https://z.ai/model-api',
    modelsDocUrl: 'https://docs.z.ai/guides/llm/glm-4.6',
    modelFlagDocUrl: 'https://docs.z.ai/scenario-example/develop-tools/claude',
    warning: 'Runs the Claude Code binary against z.ai’s Anthropic-compatible endpoint. Requires the `claude` CLI installed and a z.ai key (ZAI_API_KEY / zai_api_key). Pick the GLM model via ZAI_CLI_MODEL.',
  },
});

const kimiCliConfig: CLIToolConfig = makeAnthropicCompatCliConfig({
  name: 'Claude Code (Moonshot Kimi)',
  modelPatterns: ['cli/kimi', 'cli/kimi-code', 'cli/moonshot'],
  modelLabel: 'cli/kimi',
  baseUrlEnv: 'MOONSHOT_ANTHROPIC_BASE_URL',
  defaultBaseUrl: 'https://api.moonshot.ai/anthropic',
  keyEnv: 'MOONSHOT_API_KEY',
  keyVault: 'moonshot_api_key',
  modelEnv: 'MOONSHOT_CLI_MODEL',
  defaultModel: 'kimi-k2-0711-preview',
  quotaProvider: 'moonshot-cli',
  modelProvider: 'moonshot',
  billingInfo: {
    vendor: 'Moonshot (Kimi)',
    planNote: 'Kimi Code plan or pay-per-token Moonshot API key',
    billingMode: 'mixed',
    pricingDocUrl: 'https://platform.moonshot.ai/',
    modelsDocUrl: 'https://platform.kimi.ai/docs/models',
    modelFlagDocUrl: 'https://platform.kimi.ai/docs/api/overview',
    warning: 'Runs the Claude Code binary against Moonshot’s Anthropic-compatible endpoint. Requires the `claude` CLI installed and a Moonshot key (MOONSHOT_API_KEY / moonshot_api_key). Pick the Kimi model via MOONSHOT_CLI_MODEL. Note: Moonshot rescales temperature (×0.6).',
  },
});

/** All registered CLI tool configs */
export const CLI_TOOLS: CLIToolConfig[] = [claudeCodeConfig, antigravityConfig, codexCliConfig, vibeCliConfig, glmCliConfig, kimiCliConfig];

export { antigravityConfig, claudeCodeConfig, codexCliConfig, glmCliConfig, kimiCliConfig, vibeCliConfig };

/**
 * CLI Provider — wraps subscription-based CLI tools (Claude Code, Antigravity, Codex, Mistral Vibe)
 * as subprocess calls. Tracks quota and detects exhaustion.
 */
export class CLIProvider implements ModelProvider {
  readonly name = 'cli';
  readonly type = 'cli' as const;

  private toolAvailability = new Map<string, boolean>();

  supportsModel(modelName: string): boolean {
    return CLI_TOOLS.some(tool =>
      tool.modelPatterns.some(p => modelName === p || modelName.startsWith(p + '/'))
    );
  }

  private getToolConfig(modelName: string): CLIToolConfig | null {
    return CLI_TOOLS.find(tool =>
      tool.modelPatterns.some(p => modelName === p || modelName.startsWith(p + '/'))
    ) || null;
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const tool = this.getToolConfig(options.model);
    if (!tool) {
      throw classifyError(new Error(`No CLI tool found for model: ${options.model}`), 'cli');
    }

    // Check quota before executing
    const quotaTracker = getQuotaTracker();
    const quota = await quotaTracker.getStatus(tool.quotaProvider);
    if (quota.exhausted) {
      throw classifyError(new Error(`Quota exhausted for ${tool.name}. Resets at ${quota.resetsAt?.toISOString() || 'unknown'}`), 'cli');
    }

    // Build prompt from messages (combine system + user messages)
    const prompt = this.buildPrompt(options);
    const args = tool.buildArgs(prompt);
    const env = tool.buildEnv ? await tool.buildEnv() : undefined;
    const startTime = Date.now();

    modelLogger.debug({ tool: tool.name, model: options.model }, 'Executing CLI tool');

    try {
      // Same allowlisted child env as the agent worker — never the server's
      // full environment (DB credentials, every provider key). The model row's
      // `cliAgent.inheritApiKeys` opts a key-mode CLI back into its own key,
      // exactly as it does for managed runs.
      const { getModelRegistry } = await import('../model-registry');
      const row = await getModelRegistry().getModel(options.model).catch(() => null)
        ?? await getModelRegistry().getModelByModelId(options.model).catch(() => null);
      const inheritApiKeys = row?.metadata?.cliAgent?.inheritApiKeys === true;
      const release = await acquireCliSlot();
      let stdout: string;
      try {
        stdout = await this.execCli(tool.binaryPath, args, { env: buildChildEnv(tool, env, inheritApiKeys) });
      } finally {
        release();
      }
      const result = tool.parseOutput(stdout, startTime);

      // Track usage
      await quotaTracker.trackUsage(tool.quotaProvider, {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });

      modelLogger.debug({
        tool: tool.name,
        latencyMs: result.latencyMs,
        tokens: result.usage.totalTokens,
      }, 'CLI tool completed');

      return result;
    } catch (error) {
      const errMsg = (error as Error).message;

      // Check if this is a quota error
      if (tool.isQuotaError(errMsg)) {
        await quotaTracker.markExhausted(tool.quotaProvider);
        modelLogger.warn({ tool: tool.name }, 'CLI tool quota exhausted');
        throw classifyError(new Error(`Quota exhausted for ${tool.name}: ${errMsg}`), 'cli');
      }

      throw classifyError(error, 'cli');
    }
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    // CLI tools don't truly stream — execute and yield the full result as one chunk
    const result = await this.complete(options);
    yield { content: result.content };
    yield { finishReason: result.finishReason };
  }

  async checkHealth(): Promise<ProviderHealthStatus> {
    // Check which CLI tools are available
    const available: string[] = [];

    for (const tool of CLI_TOOLS) {
      const isAvailable = await this.checkToolAvailable(tool);
      this.toolAvailability.set(tool.name, isAvailable);
      if (isAvailable) available.push(tool.name);
    }

    if (available.length === 0) {
      return { healthy: false, error: 'No CLI tools available' };
    }

    return { healthy: true };
  }

  async getQuotaStatus(): Promise<QuotaStatus> {
    const quotaTracker = getQuotaTracker();

    // Aggregate across all CLI tools
    let anyExhausted = false;
    let earliestReset: Date | undefined;

    for (const tool of CLI_TOOLS) {
      const status = await quotaTracker.getStatus(tool.quotaProvider);
      if (status.exhausted) {
        anyExhausted = true;
        if (status.resetsAt && (!earliestReset || status.resetsAt < earliestReset)) {
          earliestReset = status.resetsAt;
        }
      }
    }

    return {
      provider: 'cli',
      hasQuota: !anyExhausted,
      exhausted: anyExhausted,
      resetsAt: earliestReset,
    };
  }

  /** Get quota status for a specific CLI tool */
  async getToolQuotaStatus(modelName: string): Promise<QuotaStatus | null> {
    const tool = this.getToolConfig(modelName);
    if (!tool) return null;

    const quotaTracker = getQuotaTracker();
    return quotaTracker.getStatus(tool.quotaProvider);
  }

  /** List all available CLI tools */
  async getAvailableTools(): Promise<{
    name: string;
    available: boolean;
    modelPatterns: string[];
    modelProvider: 'anthropic' | 'google' | 'openai' | 'mistral' | 'zai' | 'moonshot';
    modelFlag: string;
    billingInfo: CLIBillingInfo;
    adapter: string;
    capabilities: string;
  }[]> {
    const results = [];
    for (const tool of CLI_TOOLS) {
      const available = this.toolAvailability.get(tool.name) ?? await this.checkToolAvailable(tool);
      results.push({
        name: tool.name,
        available,
        modelPatterns: tool.modelPatterns,
        modelProvider: tool.modelProvider,
        modelFlag: tool.modelFlag,
        billingInfo: tool.billingInfo,
        adapter: tool.adapter ?? tool.name,
        capabilities: describeCliCapabilities(tool),
      });
    }
    return results;
  }

  // Overridable seam: delegates to module-level execCli so tests can stub
  // `(provider as any).execCli` to force a classified error without
  // spawning a real subprocess.
  private execCli(binary: string, args: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<string> {
    return execCli(binary, args, opts);
  }

  private buildPrompt(options: CompletionOptions): string {
    const parts: string[] = [];
    for (const msg of options.messages) {
      if (msg.role === 'system') {
        parts.push(`[System] ${msg.content}`);
      } else if (msg.role === 'user') {
        parts.push(msg.content);
      } else if (msg.role === 'assistant') {
        parts.push(`[Octipus] ${msg.content}`);
      }
    }
    return parts.join('\n\n');
  }

  private async checkToolAvailable(tool: CLIToolConfig): Promise<boolean> {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    try {
      await execCli(cmd, [tool.binaryPath], { timeoutMs: 5_000 });
      return true;
    } catch {
      // Recoverable: binary not found → tool simply marked unavailable
      return false;
    }
  }
}

/**
 * Windows `shell:true` command-line quoting for one argument, following the
 * MSVCRT / CommandLineToArgvW convention every Windows CLI's argv parser
 * expects: wrap in quotes when the value has whitespace or an embedded
 * quote, escape embedded quotes, and double any run of backslashes that
 * sits immediately before a quote (embedded or closing) — a lone trailing
 * backslash before the closing quote would otherwise escape it instead of
 * terminating the argument, e.g. a path like `C:\some path\`.
 *
 * Values with no whitespace or quote pass through unquoted — matches Node's
 * own (unquoted) behavior for the common case and keeps diffs to existing
 * commands minimal.
 */
export function windowsShellQuote(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const ch of value) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      result += '\\'.repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  result += '\\'.repeat(backslashes * 2) + '"';
  return result;
}

/**
 * The guarded CLI spawn: kill-tree timeout, bounded output buffers. Exported
 * (alongside {@link acquireCliSlot}) so any one-shot CLI invocation outside
 * `CLIProvider.complete` — e.g. `cli-session-compact.ts` pushing octipus's
 * compaction into a live vendor session — goes through the same guard rails
 * as a normal completion instead of spawning unbounded.
 */
export function execCli(binary: string, args: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<string> {
  return new Promise((resolve, reject) => {
    // Fixed generous default, not a maxTokens*100ms heuristic (which could
    // arm a sub-second timeout for a small budget or a 3h one for a big
    // batch). CLI subscription tools are slow; 10 min is a safe ceiling.
    const timeout = opts?.timeoutMs ?? 600_000;
    // agy is a native binary — shell:true on Windows would re-tokenize its
    // argv (breaking the prompt); only .cmd wrappers need the shell.
    const noShell = binary === 'agy';
    const useShell = process.platform === 'win32' && !noShell;
    // shell:true hands the command line to cmd.exe, and Node joins
    // [binary, ...args] with plain spaces, quoting nothing — an unquoted
    // prompt with spaces (e.g. `/compact focus on the migration`) is
    // re-tokenized into separate argv. Same fix as cli-agent-worker's spawn.
    const shellQuote = (value: string): string => (useShell ? windowsShellQuote(value) : value);
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- array-form spawn (no shell interpolation); binary/args come from vetted provider config, not request input
    const proc = spawn(shellQuote(binary), args.map(shellQuote), {
      // Run in the workspace root, not wherever the server was launched — a
      // CLI completion must not read/write the octipus repo by default.
      cwd: resolveWorkspaceRoot(),
      env: opts?.env ?? { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
    });

    // NOT spawn's own `timeout`: with shell:true (Windows) that kills the
    // cmd.exe wrapper and leaves the real CLI running as an orphan — the
    // observed failure mode where dead completions kept `claude` processes
    // alive. Kill the whole process tree instead.
    let timedOut = false;
    const killTree = () => {
      if (proc.pid == null) return;
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => proc.kill('SIGKILL'));
      } else {
        proc.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      modelLogger.warn({ binary, timeout }, 'CLI tool timed out — killing process tree');
      killTree();
    }, timeout);
    timer.unref?.();

    // Bound output buffers so a runaway CLI can't exhaust memory.
    const MAX_BUF = 4 * 1024 * 1024;
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      if (stdout.length < MAX_BUF) stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      if (stderr.length < MAX_BUF) stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`CLI ${binary} timed out after ${timeout}ms`));
      } else if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`CLI ${binary} exited with code ${code}: ${stderr || stdout}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn ${binary}: ${err.message}`));
    });
  });
}
