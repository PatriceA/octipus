import { agentLogger } from '@/utils/logger';
import type { AgentEvent } from './agent-base';
import type { CLIAgentConfig } from '@/db/schema/models';

/**
 * Builds CLI arguments for different agent tools (Claude Code, Gemini CLI, Codex).
 */
export class CLIArgumentBuilder {
  build(
    toolName: string,
    prompt: string,
    settings: CLIAgentConfig,
    systemMessages: string[],
  ): { binary: string; args: string[] } {
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
  ): { binary: string; args: string[] } {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];

    const permMode = settings.permissionMode || 'bypassPermissions';
    args.push('--permission-mode', permMode);

    if (systemMessages.length > 0) {
      args.push('--append-system-prompt', systemMessages.join('\n'));
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

    return { binary: 'claude', args };
  }

  private buildGeminiArgs(
    prompt: string,
    settings: CLIAgentConfig,
  ): { binary: string; args: string[] } {
    const args = ['-p', prompt, '-o', 'stream-json'];

    const approvalMode = settings.permissionMode || 'yolo';
    args.push('--approval-mode', approvalMode);

    if (settings.extraArgs?.length) {
      args.push(...settings.extraArgs);
    }

    return { binary: 'gemini', args };
  }

  private buildCodexArgs(prompt: string): { binary: string; args: string[] } {
    return { binary: 'codex', args: ['exec', '--skip-git-repo-check', '--json', prompt] };
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
    if (type === 'stream_event') {
      const inner = event.event as Record<string, unknown> | undefined;
      if (!inner) return null;

      const innerType = inner.type as string;

      if (innerType === 'content_block_start') {
        const block = inner.content_block as Record<string, unknown> | undefined;
        if (block?.type === 'tool_use') {
          this.onIteration();
          this.emitFn('action', {
            tool: block.name,
            type: 'cli_tool_use',
            toolName: block.name,
          });
        }
      }

      return null;
    }

    if (type === 'assistant') {
      const content = event.message as Record<string, unknown> | undefined;
      if (content?.content) {
        const blocks = content.content as Array<Record<string, unknown>>;
        const textBlocks = blocks.filter((b) => b.type === 'text');
        if (textBlocks.length > 0) {
          const text = textBlocks.map((b) => b.text as string).join('');
          this.emitFn('thought', { text: text.slice(0, 200), model: this.model });
          return { text, replace: true };
        }
      }
      return null;
    }

    if (type === 'result') {
      const result = (event.result as string) || '';
      if (result) {
        return { text: result, replace: true };
      }
      const text = event.text as string | undefined;
      return text ? { text, replace: true } : null;
    }

    return null;
  }

  private parseGeminiEvent(event: Record<string, unknown>, type: string): { text: string; replace?: boolean } | null {
    if (type === 'init') {
      const model = event.model as string || 'gemini';
      this.emitFn('thought', { model, status: 'initialized', sessionId: event.session_id });
      return null;
    }

    if (type === 'message') {
      const role = event.role as string;
      const content = event.content as string | undefined;

      if (role === 'assistant' && content) {
        return { text: content };
      }
      return null;
    }

    if (type === 'tool_use' || type === 'tool_call') {
      this.onIteration();
      this.emitFn('action', {
        tool: event.tool_name || event.tool || event.name || 'unknown',
        type: 'cli_tool_use',
        toolName: event.tool_name || event.tool || event.name,
        args: event.parameters || event.args,
      });
      return null;
    }

    if (type === 'tool_result') {
      this.emitFn('observation', {
        tool: event.tool_name || event.tool || event.name,
        toolId: event.tool_id,
        status: event.status,
        result: typeof event.output === 'string' ? (event.output as string).slice(0, 500) : event.output,
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
    if (type === 'message' && event.content) {
      return { text: event.content as string };
    }
    if (type === 'result' && event.text) {
      return { text: event.text as string, replace: true };
    }
    if (type === 'tool_call') {
      this.onIteration();
      this.emitFn('action', {
        tool: event.name || 'unknown',
        type: 'cli_tool_use',
        toolName: event.name,
      });
    }
    return null;
  }
}
