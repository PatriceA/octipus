import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir, } from 'os';
import { join, resolve } from 'path';
import type { CLIAgentConfig } from '@/db/schema/models';
import { coreLogger } from '@/utils/logger';
import type { AgentEvent } from './agent-base';

const IS_WIN = process.platform === 'win32';

/**
 * Generate a temporary MCP config file that points CLI tools to Octipus's MCP server.
 * Returns the path to the generated config file, or null if the MCP server isn't available.
 */
function getOrCreateMcpConfig(): string | null {
  const dir = join(tmpdir(), 'octipus-cli');
  const configPath = join(dir, 'mcp-config.json');

  // Reuse existing if fresh (< 1 hour old)
  try {
    if (existsSync(configPath)) {
      const stat = Bun.file(configPath);
      if (Date.now() - stat.lastModified < 3600_000) return configPath;
    }
  } catch (err) { coreLogger.error({ err }, 'silent failure in cli-adapters'); }

  // Build MCP server path — resolve from project root
  const projectRoot = resolve(join(import.meta.dir, '../..'));
  const mcpServerEntry = join(projectRoot, 'mcp-server/dist/index.js');
  const mcpServerSrc = join(projectRoot, 'mcp-server/src/index.ts');

  // Determine entry point — prefer compiled, fall back to source (bun can run .ts)
  const entry = existsSync(mcpServerEntry) ? mcpServerEntry : mcpServerSrc;
  const runtime = existsSync(mcpServerEntry) ? 'node' : 'bun';

  const apiPort = process.env.API_PORT || process.env.PORT || '3005';
  const apiKey = process.env.MASTER_KEY || process.env.OCTIPUS_API_KEY || '';

  const config = {
    mcpServers: {
      octipus: {
        command: runtime,
        args: [entry],
        env: {
          OCTIPUS_URL: `http://127.0.0.1:${apiPort}`,
          ...(apiKey ? { OCTIPUS_API_KEY: apiKey } : {}),
        },
      },
    },
  };

  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

/** Detect a more descriptive tool name from a shell command */
function detectToolFromCommand(command: string): string {
  const cmd = command.trim().split(/\s+/)[0]?.replace(/^.*\//, '') || 'shell';
  const toolMap: Record<string, string> = {
    cat: 'read_file', find: 'find', ls: 'list', grep: 'search', rg: 'search',
    sed: 'edit_file', mkdir: 'create_dir', rm: 'delete', cp: 'copy', mv: 'move',
    flutter: 'flutter', npm: 'npm', bun: 'bun', git: 'git', docker: 'docker',
    cd: 'shell', echo: 'shell', python: 'python', python3: 'python', node: 'node',
  };
  // Check for redirects (cat > file = write)
  if (/>\s*\S/.test(command) && !command.includes('>>')) return 'write_file';
  if (/>>/.test(command)) return 'append_file';
  return toolMap[cmd] || cmd;
}

/** Detect file changes from shell commands like `cat > file`, `sed -i`, `mkdir -p` */
function detectFileChangeFromCommand(command: string): { action: string; path: string } | null {
  // cat > file or cat >> file
  const catWrite = command.match(/cat\s+>+\s*(\S+)/);
  if (catWrite) return { action: catWrite[0].includes('>>') ? 'append' : 'write', path: catWrite[1] };
  // sed -i (in-place edit)
  const sedEdit = command.match(/sed\s+-i\s+.*?\s+(\S+)\s*$/);
  if (sedEdit) return { action: 'edit', path: sedEdit[1] };
  // mkdir -p
  const mkdirCreate = command.match(/mkdir\s+-p\s+(\S+)/);
  if (mkdirCreate) return { action: 'create_dir', path: mkdirCreate[1] };
  // rm / rm -rf
  const rmDelete = command.match(/rm\s+(?:-\w+\s+)?(\S+)/);
  if (rmDelete) return { action: 'delete', path: rmDelete[1] };
  return null;
}

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
    systemPrompt?: string | null,
  ): { binary: string; args: string[]; stdinPrompt?: string } {
    switch (toolName) {
      case 'Claude Code':
        return this.buildClaudeArgs(prompt, settings, systemMessages);
      case 'Gemini CLI':
        return this.buildGeminiArgs(prompt, settings, systemPrompt);
      case 'Codex CLI':
        return this.buildCodexArgs(prompt, systemPrompt, settings);
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

    // Note: do NOT pass --bare. It explicitly disables OAuth and keychain
    // reads ("Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper"),
    // which makes the spawned subprocess return "Not logged in · Please run
    // /login" for users authenticated via `claude login` (OAuth). Plugin/hook
    // leakage from the host config is the accepted trade-off.

    const permMode = settings.permissionMode || 'bypassPermissions';
    args.push('--permission-mode', permMode);

    // Model override: env var > settings > vendor default. Vendor accepts an
    // alias ('sonnet', 'opus') or a full model id ('claude-sonnet-4-6').
    // https://code.claude.com/docs/en/cli-reference
    const claudeModel = process.env.CLAUDE_MODEL || settings.model;
    if (claudeModel) {
      args.push('--model', claudeModel);
    }

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

    // MCP config: prefer explicit setting, otherwise auto-generate
    const mcpConfig = settings.mcpConfigPath || getOrCreateMcpConfig();
    if (mcpConfig) {
      args.push('--mcp-config', mcpConfig);
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
    systemPrompt?: string | null,
  ): { binary: string; args: string[]; stdinPrompt?: string } {
    // Gemini CLI: -p is "Appended to input on stdin (if any)".
    // So stdin runs FIRST as context, then -p is the user prompt.
    // This lets us pipe the system/expert prompt via stdin so Gemini treats
    // it as authoritative context, not just part of the user message.
    const args = ['-o', 'stream-json'];

    const approvalMode = settings.permissionMode || 'yolo';
    args.push('--approval-mode', approvalMode);

    // Model override: env var > settings. Vendor uses gemini-2.5-flash by default.
    // https://github.com/google-gemini/gemini-cli (Quickstart, `-m` flag)
    const geminiModel = process.env.GEMINI_MODEL || settings.model;
    if (geminiModel) {
      args.push('-m', geminiModel);
    }

    // Note: Gemini CLI does NOT support --mcp-config or --system-instruction flags.
    // It uses its own `gemini mcp` subcommand to manage MCP servers.
    // The octipus MCP server must be added via: gemini mcp add octipus

    if (settings.extraArgs?.length) {
      args.push(...settings.extraArgs);
    }

    // Pass system prompt via stdin (Gemini appends -p after stdin content).
    if (systemPrompt) {
      args.push('-p', prompt);
      return { binary: 'gemini', args, stdinPrompt: systemPrompt };
    }

    if (IS_WIN) {
      args.push('--prompt=.');
      return { binary: 'gemini', args, stdinPrompt: prompt };
    }

    args.push('-p', prompt);
    return { binary: 'gemini', args };
  }

  /**
   * Write content to a temp file, returning the path.
   * Used on Windows to bypass the ~8191-char command-line limit.
   */
  private writeTempFile(prefix: string, content: string): string {
    const dir = join(tmpdir(), 'octipus-cli');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${prefix}${randomBytes(6).toString('hex')}.txt`);
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  private buildCodexArgs(
    prompt: string,
    systemPrompt?: string | null,
    settings?: CLIAgentConfig,
  ): { binary: string; args: string[]; stdinPrompt?: string } {
    // Codex: positional prompt or '-' to read from stdin.
    // Multi-line prompts or oversized args break the positional path —
    // codex prints "Reading additional input from stdin..." then exits 1 when
    // the argv text contains newlines. Always pipe via stdin in that case.
    // Short single-line prompts may still go as a positional.
    //
    // Model override via `-c model="<name>"`: bypasses ~/.codex/config.toml so
    // a host default like `gpt-5.2-codex` (blocked on ChatGPT-account auth)
    // cannot silently exit 1 for every codex-routed swarm child. Default to
    // gpt-5.4 (the successor per codex migration notice) unless overridden.
    const modelOverride = process.env.CODEX_MODEL || settings?.model || 'gpt-5.4';
    const baseArgs = [
      'exec',
      '--skip-git-repo-check',
      '--json',
      '--ephemeral',
      '-c', `model="${modelOverride}"`,
    ];
    if (settings?.extraArgs?.length) baseArgs.push(...settings.extraArgs);

    if (systemPrompt) {
      const combined = `${systemPrompt}\n\n---\n\n${prompt}`;
      return { binary: 'codex', args: [...baseArgs, '-'], stdinPrompt: combined };
    }

    const needsStdin = IS_WIN || prompt.includes('\n') || prompt.length > 1024;
    if (needsStdin) {
      return { binary: 'codex', args: [...baseArgs, '-'], stdinPrompt: prompt };
    }
    return { binary: 'codex', args: [...baseArgs, prompt] };
  }
}

/**
 * Parses streaming JSON output from CLI agent tools.
 *
 * `onTokenUsage` is called whenever a terminal usage block is observed
 * (Codex `turn.completed`, Claude `result`, Gemini `result`). The worker
 * uses it to sum tokens across turns so `getTotalTokens()` returns a real
 * number instead of the base-class zero. Without this hook, swarm nodes
 * spawned on CLI providers record 0 tokens even though the provider told
 * us the count.
 */
export class CLIOutputParser {
  constructor(
    private agentId: string,
    private model: string,
    private emitFn: (type: AgentEvent['type'], data: unknown) => void,
    private onIteration: () => void,
    private onTokenUsage?: (tokens: { input: number; output: number; total: number }) => void,
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

          // Also emit file_change for file-modifying tools
          const claudeFileTools: Record<string, string> = { Write: 'write', Edit: 'edit' };
          const toolName = block.name as string;
          if (claudeFileTools[toolName] && block.input) {
            const input = block.input as Record<string, unknown>;
            const filePath = (input.file_path || input.path) as string | undefined;
            if (filePath) {
              this.emitFn('action', {
                type: 'file_change',
                action: claudeFileTools[toolName],
                path: filePath,
                content: (input.content || input.new_string) as string | undefined,
                oldContent: (input.old_string) as string | undefined,
              });
            }
          }
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

      const totalTokens = inputTokens + outputTokens + cacheRead + cacheCreation;
      this.emitFn('thought', {
        status: 'completed',
        sessionId: event.session_id,
        stats: {
          totalTokens,
          inputTokens,
          outputTokens,
          cacheRead,
          cacheCreation,
          durationMs,
          numTurns,
          totalCostUsd,
        },
      });
      this.onTokenUsage?.({ input: inputTokens + cacheRead + cacheCreation, output: outputTokens, total: totalTokens });

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

      // Also emit file_change for file-modifying tools
      const geminiFileTools: Record<string, string> = {
        replace_file: 'edit', write_file: 'write', create_file: 'write',
        delete_file: 'delete', patch_file: 'edit', update_file: 'edit',
      };
      const toolName = event.tool_name as string;
      if (geminiFileTools[toolName] && event.parameters) {
        const params = event.parameters as Record<string, unknown>;
        const filePath = (params.file_path || params.path || params.filename) as string | undefined;
        if (filePath) {
          this.emitFn('action', {
            type: 'file_change',
            action: geminiFileTools[toolName],
            path: filePath,
            content: (params.content || params.new_content) as string | undefined,
            oldContent: (params.old_content) as string | undefined,
          });
        }
      }

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
        const inputTokens = (stats.input_tokens || 0) as number;
        const outputTokens = (stats.output_tokens || 0) as number;
        const totalTokens = (stats.total_tokens as number | undefined) ?? (inputTokens + outputTokens);
        this.emitFn('thought', {
          status: 'completed',
          stats: {
            totalTokens,
            inputTokens,
            outputTokens,
            durationMs: stats.duration_ms,
            toolCalls: stats.tool_calls,
          },
        });
        this.onTokenUsage?.({ input: inputTokens, output: outputTokens, total: totalTokens });
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
        const command = (item.command || '') as string;
        // Detect the actual tool from the command for better display
        const toolName = detectToolFromCommand(command);
        this.emitFn('action', {
          type: 'cli_tool_use',
          toolName,
          args: { command },
        });

        // Detect file changes from shell commands
        const fileChange = detectFileChangeFromCommand(command);
        if (fileChange) {
          this.emitFn('action', {
            type: 'file_change',
            action: fileChange.action,
            path: fileChange.path,
          });
        }
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
        const totalTokens = inputTokens + outputTokens;
        this.emitFn('thought', {
          status: 'completed',
          stats: {
            totalTokens,
            inputTokens,
            outputTokens,
            cacheRead: cachedTokens,
          },
        });
        this.onTokenUsage?.({ input: inputTokens + cachedTokens, output: outputTokens, total: totalTokens });
      }
      return null;
    }

    return null;
  }
}
