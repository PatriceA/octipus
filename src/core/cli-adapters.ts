import { agentLogger } from '@/utils/logger';
import type { AgentEvent } from './agent-base';
import type { CLIAgentConfig } from '@/db/schema/models';

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
      args.push('-p', '--output-format', 'stream-json', '--bare');
    } else {
      args.push('-p', prompt, '--output-format', 'stream-json', '--bare');
    }

    const permMode = settings.permissionMode || 'bypassPermissions';
    args.push('--permission-mode', permMode);

    if (systemMessages.length > 0) {
      // On Windows, use = format to keep it as one token for the shell
      const sysPrompt = systemMessages.join('\n');
      if (IS_WIN) {
        args.push(`--append-system-prompt=${sysPrompt}`);
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
    // Gemini CLI stream-json format:
    // { type: "init", model, session_id }
    // { type: "message", role: "user"|"assistant", content }
    // { type: "tool_call", tool_name, tool_args }
    // { type: "tool_result", tool_name, output }
    // { type: "stats", total_tokens, input_tokens, output_tokens, duration_ms, tool_calls }

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
        return { text: content, replace: true };
      }
      return null;
    }

    if (type === 'tool_call') {
      this.onIteration();
      this.emitFn('action', {
        type: 'cli_tool_use',
        toolName: event.tool_name || event.name,
        args: event.tool_args || event.args,
      });
      return null;
    }

    if (type === 'tool_result') {
      // Tool results from Gemini — just log, don't surface
      return null;
    }

    if (type === 'stats') {
      const stats = event as Record<string, unknown>;
      if (stats.total_tokens || stats.duration_ms) {
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
    // Codex --json outputs: message, function_call, function_call_output, result
    if (type === 'message' && (event.content || event.text)) {
      const text = (event.content || event.text) as string;
      return { text };
    }

    // Tool call events (function_call is the Codex format)
    if (type === 'function_call' || type === 'tool_call') {
      this.onIteration();
      const name = (event.name || event.tool_name || event.function) as string;
      this.emitFn('action', {
        type: 'cli_tool_use',
        toolName: name,
        args: event.arguments || event.tool_args || event.args,
      });
      return null;
    }

    // Tool result/output
    if (type === 'function_call_output' || type === 'tool_result') {
      return null; // Just log, don't surface
    }

    // Final result
    if (type === 'result') {
      const text = (event.text || event.result || event.content || '') as string;
      this.emitFn('thought', {
        status: 'completed',
        stats: {
          durationMs: event.duration_ms,
        },
      });
      return text ? { text, replace: true } : null;
    }

    // Catch-all: if event has content/text, surface it
    if (event.content || event.text) {
      return { text: (event.content || event.text) as string };
    }

    return null;
  }
}
