import { spawn } from 'child_process';
import { classifyError } from '@/core/errors/classification';
import { modelLogger } from '@/utils/logger';
import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import { getQuotaTracker } from '../quota-tracker';
import type { ModelProvider, ProviderHealthStatus, QuotaStatus } from './interface';

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
};

// ---- Gemini CLI ----
const geminiCliConfig: CLIToolConfig = {
  name: 'Gemini CLI',
  modelPatterns: ['cli/gemini', 'cli/gemini-cli'],
  binaryPath: 'gemini',
  buildArgs: (prompt: string) => ['-p', prompt, '-o', 'json'],
  parseOutput: (stdout: string, startTime: number): CompletionResult => {
    try {
      const data = JSON.parse(stdout);
      const content = typeof data === 'string' ? data : (data.response || data.text || data.content || JSON.stringify(data));
      return {
        content,
        finishReason: 'stop',
        usage: {
          inputTokens: data.input_tokens || data.usage?.inputTokens || 0,
          outputTokens: data.output_tokens || data.usage?.outputTokens || 0,
          totalTokens: (data.input_tokens || 0) + (data.output_tokens || 0),
        },
        model: 'cli/gemini-cli',
        latencyMs: Date.now() - startTime,
      };
    } catch {
      return {
        content: stdout.trim(),
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        model: 'cli/gemini-cli',
        latencyMs: Date.now() - startTime,
      };
    }
  },
  isQuotaError: (output: string) =>
    /rate.?limit|quota|exceeded|resource.?exhausted/i.test(output),
  quotaProvider: 'gemini-cli',
};

// ---- Codex CLI ----
const codexCliConfig: CLIToolConfig = {
  name: 'Codex CLI',
  modelPatterns: ['cli/codex', 'cli/codex-cli'],
  binaryPath: 'codex',
  buildArgs: (prompt: string) => ['exec', '--json', prompt],
  parseOutput: (stdout: string, startTime: number): CompletionResult => {
    try {
      // Codex outputs JSONL events, take the last message event
      const lines = stdout.trim().split('\n').filter(Boolean);
      let content = '';
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'message' && event.content) {
            content = event.content;
          } else if (event.type === 'result' && event.text) {
            content = event.text;
          }
        } catch {
          // Skip non-JSON lines
        }
      }
      if (!content && lines.length > 0) {
        // Fallback: try to parse the whole output
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
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
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
};

/** All registered CLI tool configs */
export const CLI_TOOLS: CLIToolConfig[] = [claudeCodeConfig, geminiCliConfig, codexCliConfig];

export { claudeCodeConfig, codexCliConfig, geminiCliConfig };

/**
 * CLI Provider — wraps subscription-based CLI tools (Claude Code, Gemini CLI, Codex)
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
  async getAvailableTools(): Promise<{ name: string; available: boolean; modelPatterns: string[] }[]> {
    const results = [];
    for (const tool of CLI_TOOLS) {
      const available = this.toolAvailability.get(tool.name) ?? await this.checkToolAvailable(tool);
      results.push({ name: tool.name, available, modelPatterns: tool.modelPatterns });
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
        parts.push(`[Assistant] ${msg.content}`);
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
