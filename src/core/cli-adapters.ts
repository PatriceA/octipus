import { agentLogger } from '@/utils/logger';
import type { AgentEvent } from './agent-base';
import type { CLIAgentConfig } from '@/db/schema/models';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

const IS_WIN = process.platform === 'win32';

/**
 * Builds CLI arguments for different agent tools (Claude Code, Gemini CLI, Codex).
 *
 * On Windows, prompts are piped via stdin (not as args) because shell: true
 * is required for .cmd wrappers but mangles long/special-char arguments.
 * When stdinPrompt is returned, the caller must write it to proc.stdin.
 */
export class CLIArgumentBuilder {
  build(
    toolName: string,
    prompt: string,
    settings: CLIAgentConfig,
    systemMessages: string[],
  ): { binary: string; args: string[]; stdinPrompt?: string } {
    switch (toolName) {
      case 'Claude Code':
        return this.buildClaudeArgs(prompt, settings, systemMessages);
      case 'Gemini CLI':
        return this.buildGeminiArgs(prompt, settings);
      case 'Codex CLI':
        return this.buildCodexArgs(prompt);
      default:
        throw new Error(`Unknown CLI tool: ${toolName}`);
    }
  }

  private buildClaudeArgs(
    prompt: string,
    settings: CLIAgentConfig,
    systemMessages: string[],
  ): { binary: string; args: string[]; stdinPrompt?: string } {
    // Claude Code: -p is a boolean flag (print mode), prompt is positional
    // On Windows: pipe prompt via stdin to avoid shell mangling
    const args: string[] = [];

    if (IS_WIN) {
      args.push('-p', '--verbose', '--output-format', 'stream-json');
    } else {
      args.push('-p', prompt, '--verbose', '--output-format', 'stream-json');
    }

    const permMode = settings.permissionMode || 'bypassPermissions';
    args.push('--permission-mode', permMode);

    if (systemMessages.length > 0) {
      const sysPrompt = systemMessages.join('\n');
      if (IS_WIN) {
        // Write to temp file to avoid Windows command-line length limit (~8191 chars)
        const tmpFile = this.writeTempFile('claude-sys-', sysPrompt);
        args.push('--append-system-prompt-file', tmpFile);
      } else {
        args.push('--append-system-prompt', sysPrompt);
      }
    }

    if (settings.mcpConfigPath) {
      args.push('--mcp-config', settings.mcpConfigPath);
    }

    if (settings.allowedTools?.length) {
      args.push('--allowedTools', ...settings.allowedTools);
    }

    if (settings.maxBudgetUsd != null) {
      args.push('--max-budget-usd', String(settings.maxBudgetUsd));
    }

    if (settings.extraArgs?.length) {
      args.push(...settings.extraArgs);
    }

    return { binary: 'claude', args, stdinPrompt: IS_WIN ? prompt : undefined };
  }

  private buildGeminiArgs(
    prompt: string,
    settings: CLIAgentConfig,
  ): { binary: string; args: string[]; stdinPrompt?: string } {
    // Gemini: -p/--prompt takes a string value, stdin is appended to it
    // On Windows: use --prompt=. (minimal placeholder), pipe real prompt via stdin
    const args = ['-o', 'stream-json'];

    const approvalMode = settings.permissionMode || 'yolo';
    args.push('--approval-mode', approvalMode);

    if (settings.extraArgs?.length) {
      args.push(...settings.extraArgs);
    }

    if (IS_WIN) {
      args.push('--prompt=.');
    } else {
      args.push('-p', prompt);
    }

    return { binary: 'gemini', args, stdinPrompt: IS_WIN ? prompt : undefined };
  }

  /**
   * Write content to a temp file, returning the path.
   * Used on Windows to bypass the ~8191-char command-line limit.
   */
  private writeTempFile(prefix: string, content: string): string {
    const dir = join(tmpdir(), 'assistant-cli');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${prefix}${randomBytes(6).toString('hex')}.txt`);
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  private buildCodexArgs(prompt: string): { binary: string; args: string[]; stdinPrompt?: string } {
    // Codex: positional prompt or '-' to read from stdin
    if (IS_WIN) {
      return { binary: 'codex', args: ['exec', '--skip-git-repo-check', '--json', '--ephemeral', '-'], stdinPrompt: prompt };
    }
    return { binary: 'codex', args: ['exec', '--skip-git-repo-check', '--json', '--ephemeral', prompt] };
  }
}

/**
 * Parses streaming JSON output from CLI agent tools.
 */
export class CLIOutputParser {
  constructor(
    private agentId: string,
    private model: string,
    private emitFn: (type: AgentEvent['type'], data: unknown) => void,
    private onIteration: () => void,
  ) {}

  /**
   * Process a streaming JSON event from the CLI binary.
   * Returns { text, replace } — text to add, replace=true means reset accumulated text.
   */
  parse(event: Record<string, unknown>, toolName: string): { text: string; replace?: boolean } | null {
    const type = event.type as string;

    if (toolName === 'Claude Code') {
      return this.parseClaudeEvent(event, type);
    }

    if (toolName === 'Gemini CLI') {
      return this.parseGeminiEvent(event, type);
    }

    if (toolName === 'Codex CLI') {
      return this.parseCodexEvent(event, type);
    }

    return null;
  }

  private parseClaudeEvent(event: Record<string, unknown>, type: string): { text: string; replace?: boolean } | null {
    // Claude Code stream-json format:
    // { type: "system", subtype: "init" }
    // { type: "assistant", message: { content: [{ type: "tool_use", name, input }, { type: "text", text }] } }
    // { type: "user" } — tool results (no details exposed)
    // { type: "result", subtype: "success", result, num_turns, duration_ms }

    if (type === 'system') {
      const subtype = event.subtype as string | undefined;
      if (subtype === 'init') {
        this.emitFn('thought', {
          status: 'running',
          sessionId: event.session_id,
        });
      }
      return null;
    }

    if (type === 'assistant') {
      const message = event.message as Record<string, unknown> | undefined;
      const content = (message?.content as Array<Record<string, unknown>>) || [];

      // Emit tool_use events
      for (const block of content) {
        if (block.type === 'tool_use') {
          this.onIteration();
          this.emitFn('action', {
            type: 'cli_tool_use',
            toolName: block.name,
            args: block.input,
          });
        }
      }

      // Extract text content
      const texts = content
        .filter(b => b.type === 'text')
        .map(b => b.text as string)
        .join('');

      return texts ? { text: texts, replace: true } : null;
    }

    if (type === 'result') {
      const result = (event.result || '') as string;
      const numTurns = event.num_turns as number | undefined;
      const durationMs = event.duration_ms as number | undefined;
      const totalCostUsd = event.total_cost_usd as number | undefined;

      // Extract token stats
      const usage = event.usage as Record<string, unknown> | undefined;
      const inputTokens = (usage?.input_tokens || 0) as number;
      const outputTokens = (usage?.output_tokens || 0) as number;
      const cacheRead = (usage?.cache_read_input_tokens || 0) as number;
      const cacheCreation = (usage?.cache_creation_input_tokens || 0) as number;

      this.emitFn('thought', {
        status: 'completed',
        sessionId: event.session_id,
        stats: {
          totalTokens: inputTokens + outputTokens + cacheRead + cacheCreation,
          inputTokens,
          outputTokens,
          cacheRead,
          cacheCreation,
          durationMs,
          numTurns,
          totalCostUsd,
        },
      });

      return result ? { text: result, replace: true } : null;
    }

    return null;
  }

  private parseGeminiEvent(event: Record<string, unknown>, type: string): { text: string; replace?: boolean } | null {
    // Gemini CLI stream-json format (verified):
    // { type: "init", model, session_id }
    // { type: "message", role: "user"|"assistant", content, delta: true }
    // { type: "tool_use", tool_name, tool_id, parameters }
    // { type: "tool_result", tool_id, status, output }
    // { type: "result", status, stats: { total_tokens, input_tokens, output_tokens, duration_ms, tool_calls } }

    if (type === 'init') {
      this.emitFn('thought', {
        status: 'running',
        sessionId: event.session_id,
        model: event.model,
      });
      return null;
    }

    if (type === 'message') {
      const role = event.role as string;
      const content = event.content as string | undefined;
      if (role === 'assistant' && content) {
        // delta: true means streaming chunks — append, don't replace
        return { text: content };
      }
      return null;
    }

    if (type === 'tool_use') {
      this.onIteration();
      this.emitFn('action', {
        type: 'cli_tool_use',
        toolName: event.tool_name,
        args: event.parameters,
      });
      return null;
    }

    if (type === 'tool_result') {
      this.emitFn('action', {
        type: 'cli_tool_result',
        toolName: event.tool_id,
        result: ((event.output || '') as string).slice(0, 500),
        status: event.status,
      });
      return null;
    }

    if (type === 'result') {
      const stats = event.stats as Record<string, unknown> | undefined;
      if (stats) {
        this.emitFn('thought', {
          status: 'completed',
          stats: {
            totalTokens: stats.total_tokens,
            inputTokens: stats.input_tokens,
            outputTokens: stats.output_tokens,
            durationMs: stats.duration_ms,
            toolCalls: stats.tool_calls,
          },
        });
      }
      return null;
    }

    return null;
  }

  private parseCodexEvent(event: Record<string, unknown>, type: string): { text: string; replace?: boolean } | null {
    // Codex --json JSONL format:
    //   { type: "thread.started", thread_id }
    //   { type: "turn.started" }
    //   { type: "item.started",   item: { id, type: "command_execution", command, status: "in_progress" } }
    //   { type: "item.completed", item: { id, type: "agent_message", text } }
    //   { type: "item.completed", item: { id, type: "command_execution", command, aggregated_output, exit_code, status } }
    //   { type: "turn.completed", usage: { input_tokens, cached_input_tokens, output_tokens } }

    const item = event.item as Record<string, unknown> | undefined;

    if (type === 'thread.started') {
      this.emitFn('thought', {
        status: 'running',
        sessionId: event.thread_id,
      });
      return null;
    }

    if (type === 'item.started' && item) {
      const itemType = item.type as string;
      if (itemType === 'command_execution') {
        this.onIteration();
        this.emitFn('action', {
          type: 'cli_tool_use',
          toolName: 'shell',
          args: { command: item.command },
        });
      }
      return null;
    }

    if (type === 'item.completed' && item) {
      const itemType = item.type as string;

      if (itemType === 'agent_message') {
        const text = (item.text || '') as string;
        return text ? { text, replace: true } : null;
      }

      if (itemType === 'command_execution') {
        // Emit the completed tool result with output
        const output = (item.aggregated_output || '') as string;
        const exitCode = item.exit_code as number | null;
        this.emitFn('action', {
          type: 'cli_tool_result',
          toolName: 'shell',
          args: { command: item.command },
          result: output.slice(0, 500),
          exitCode,
        });
        return null;
      }

      return null;
    }

    if (type === 'turn.completed') {
      const usage = event.usage as Record<string, unknown> | undefined;
      if (usage) {
        const inputTokens = (usage.input_tokens || 0) as number;
        const cachedTokens = (usage.cached_input_tokens || 0) as number;
        const outputTokens = (usage.output_tokens || 0) as number;
        this.emitFn('thought', {
          status: 'completed',
          stats: {
            totalTokens: inputTokens + outputTokens,
            inputTokens,
            outputTokens,
            cacheRead: cachedTokens,
          },
        });
      }
      return null;
    }

    return null;
  }
}
