import { spawn } from 'child_process';
import { classifyError } from '@/core/errors/classification';
import { modelLogger } from '@/utils/logger';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import { getQuotaTracker } from '../quota-tracker';
import type { ModelProvider, ProviderHealthStatus, QuotaStatus } from './interface';

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
  modelProvider: 'anthropic' | 'google' | 'openai' | 'mistral';
  /** Flag the CLI uses to select a model (`--model`, `-m`) — for docs only */
  modelFlag: string;
  /**
   * The CLI emits its entire result as a single blob at process end (e.g. vibe
   * `--output json` writes one JSON array), not incremental stream-json events.
   * When true, the CLIAgentWorker accumulates raw stdout and runs `parseOutput`
   * on the full buffer at close instead of parsing each line as an event.
   */
  bufferOutput?: boolean;
}

// ---- Claude Code CLI ----
const claudeCodeConfig: CLIToolConfig = {
  name: 'Claude Code',
  modelPatterns: ['cli/claude', 'cli/claude-code'],
  binaryPath: 'claude',
  buildArgs: (prompt: string) => ['-p', prompt, '--output-format', 'json'],
  parseOutput: (stdout: string, startTime: number): CompletionResult => {
    try {
      const data = JSON.parse(stdout);
      // claude --output-format json returns { result: string, ... }
      const content = typeof data === 'string' ? data : (data.result || data.content || JSON.stringify(data));
      return {
        content,
        finishReason: 'stop',
        usage: {
          inputTokens: data.input_tokens || data.usage?.input_tokens || 0,
          outputTokens: data.output_tokens || data.usage?.output_tokens || 0,
          totalTokens: (data.input_tokens || 0) + (data.output_tokens || 0),
        },
        model: 'cli/claude-code',
        latencyMs: Date.now() - startTime,
      };
    } catch {
      // Plain text response
      return {
        content: stdout.trim(),
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        model: 'cli/claude-code',
        latencyMs: Date.now() - startTime,
      };
    }
  },
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
// `--dangerously-skip-permissions` (not `--approval-mode`). cli/gemini model
// patterns are retained so existing model rows keep routing here.
const antigravityConfig: CLIToolConfig = {
  name: 'Antigravity',
  modelPatterns: ['cli/gemini', 'cli/gemini-cli', 'cli/antigravity', 'cli/agy'],
  binaryPath: 'agy',
  buildArgs: (prompt: string) => ['--dangerously-skip-permissions', '--print', prompt],
  // agy --print returns plain text (no structured envelope). bufferOutput=true
  // routes the whole stdout buffer here at process close.
  parseOutput: (stdout: string, startTime: number): CompletionResult => ({
    content: stdout.trim(),
    finishReason: 'stop',
    // agy reports no token usage in print mode.
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    model: 'cli/antigravity',
    latencyMs: Date.now() - startTime,
  }),
  isQuotaError: (output: string) =>
    /rate.?limit|quota|exceeded|resource.?exhausted/i.test(output),
  quotaProvider: 'antigravity',
  modelProvider: 'google',
  modelFlag: '--model',
  bufferOutput: true,
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
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
        model: 'cli/codex-cli',
        latencyMs: Date.now() - startTime,
      };
    } catch {
      return {
        content: stdout.trim(),
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
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
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          model: 'cli/vibe',
          latencyMs: Date.now() - startTime,
        };
      }
      // Unexpected non-array JSON — fall back to raw text.
      return {
        content: stdout.trim(),
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        model: 'cli/vibe',
        latencyMs: Date.now() - startTime,
      };
    } catch {
      // Plain-text / partial output — return as-is.
      return {
        content: stdout.trim(),
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
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
    planNote: 'Mistral API key (metered, stored in ~/.vibe/.env via `vibe --setup`)',
    billingMode: 'api-key',
    pricingDocUrl: 'https://mistral.ai/pricing',
    modelsDocUrl: 'https://docs.mistral.ai/getting-started/models/models_overview/',
    modelFlagDocUrl: 'https://docs.mistral.ai/',
    warning: 'vibe manages its own API key and model selection in ~/.vibe (run `vibe --setup`). Octipus stores no key for it.',
  },
};

/** All registered CLI tool configs */
export const CLI_TOOLS: CLIToolConfig[] = [claudeCodeConfig, antigravityConfig, codexCliConfig, vibeCliConfig];

export { antigravityConfig, claudeCodeConfig, codexCliConfig, vibeCliConfig };

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
    const startTime = Date.now();

    modelLogger.debug({ tool: tool.name, model: options.model }, 'Executing CLI tool');

    try {
      const stdout = await this.execCli(tool.binaryPath, args, options.maxTokens);
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
    modelProvider: 'anthropic' | 'google' | 'openai' | 'mistral';
    modelFlag: string;
    billingInfo: CLIBillingInfo;
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
      });
    }
    return results;
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

  private execCli(binary: string, args: string[], maxTokens?: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = maxTokens ? Math.max(120_000, maxTokens * 100) : 300_000; // 5 min default
      const proc = spawn(binary, args, {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
        // On Windows, CLI tools are .cmd wrappers — shell: true is required to resolve them
        shell: process.platform === 'win32',
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`CLI ${binary} exited with code ${code}: ${stderr || stdout}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn ${binary}: ${err.message}`));
      });
    });
  }

  private async checkToolAvailable(tool: CLIToolConfig): Promise<boolean> {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    try {
      await this.execCli(cmd, [tool.binaryPath]);
      return true;
    } catch {
      // Recoverable: binary not found → tool simply marked unavailable
      return false;
    }
  }
}
