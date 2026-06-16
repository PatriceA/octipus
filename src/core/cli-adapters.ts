import { randomBytes } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir, tmpdir, } from 'os';
import { join, resolve } from 'path';
import type { CLIAgentConfig } from '@/db/schema/models';
import { coreLogger } from '@/utils/logger';
import type { AgentEvent } from './agent-base';

const IS_WIN = process.platform === 'win32';

/** How to launch the Octipus MCP server as a stdio child of a CLI tool. */
interface OctipusMcpLaunch {
  /** Runtime to exec — 'node' for the compiled bundle, 'bun' for source. */
  runtime: string;
  /** Absolute path to the MCP server entry point. */
  entry: string;
  /** Loopback URL the MCP server should call back into. */
  apiUrl: string;
  /** Scoped API token (may be '' before the server has booted). */
  apiKey: string;
}

/**
 * Resolve how to launch Octipus's MCP server from the project root. Shared by
 * the Claude JSON config generator and the vibe TOML/VIBE_HOME generator so the
 * runtime/entry/port/token resolution lives in exactly one place.
 */
function resolveOctipusMcpLaunch(): OctipusMcpLaunch {
  const projectRoot = resolve(join(import.meta.dir, '../..'));
  const mcpServerEntry = join(projectRoot, 'mcp-server/dist/index.js');
  const mcpServerSrc = join(projectRoot, 'mcp-server/src/index.ts');

  // Prefer compiled, fall back to source (bun can run .ts).
  const entry = existsSync(mcpServerEntry) ? mcpServerEntry : mcpServerSrc;
  const runtime = existsSync(mcpServerEntry) ? 'node' : 'bun';

  const apiPort = process.env.API_PORT || process.env.PORT || '3005';
  // Only a scoped API token is accepted by the server now (the MASTER_KEY
  // fallback was removed with single-user mode). bin/octi writes the MCP
  // bootstrap token into OCTIPUS_API_KEY after the server boots.
  const apiKey = process.env.OCTIPUS_API_KEY || '';

  return { runtime, entry, apiUrl: `http://127.0.0.1:${apiPort}`, apiKey };
}

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

  const launch = resolveOctipusMcpLaunch();

  const config = {
    mcpServers: {
      octipus: {
        command: launch.runtime,
        args: [launch.entry],
        env: {
          OCTIPUS_URL: launch.apiUrl,
          ...(launch.apiKey ? { OCTIPUS_API_KEY: launch.apiKey } : {}),
        },
      },
    },
  };

  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

/**
 * Inject (or replace) a top-level `mcp_servers` assignment in a vibe
 * `config.toml` with one that registers the Octipus MCP server. vibe's schema
 * makes `mcp_servers` a list, and the default config writes it as an inline
 * empty array (`mcp_servers = []`) — so we replace that single-line assignment
 * with an inline array-of-tables. (A `[[mcp_servers]]` table block would
 * collide with the existing `mcp_servers = []` and be a TOML redefinition.)
 */
export function injectVibeMcpServer(config: string, launch: OctipusMcpLaunch): string {
  // JSON.stringify produces TOML-valid string/array literals for our values
  // (double-quoted strings, `["..."]` arrays).
  const command = JSON.stringify(launch.runtime);
  const argsArr = JSON.stringify([launch.entry]);
  const env = launch.apiKey
    ? `, env = { OCTIPUS_URL = ${JSON.stringify(launch.apiUrl)}, OCTIPUS_API_KEY = ${JSON.stringify(launch.apiKey)} }`
    : `, env = { OCTIPUS_URL = ${JSON.stringify(launch.apiUrl)} }`;
  const assignment =
    `mcp_servers = [\n` +
    `  { name = "octipus", transport = "stdio", command = ${command}, args = ${argsArr}${env} },\n` +
    `]`;

  // Replace an existing single-line inline `mcp_servers = [ ... ]` assignment.
  if (/^mcp_servers\s*=\s*\[.*\]\s*$/m.test(config)) {
    return config.replace(/^mcp_servers\s*=\s*\[.*\]\s*$/m, assignment);
  }
  // No inline assignment found (e.g. user uses [[mcp_servers]] tables) — append.
  return `${config.trimEnd()}\n${assignment}\n`;
}

/**
 * Build an ephemeral `VIBE_HOME` seeded from the host's real `~/.vibe`, with the
 * Octipus MCP server merged into `config.toml`. vibe honors `VIBE_HOME` to
 * relocate its config dir; spawning with `env.VIBE_HOME` set lets us register
 * the MCP server without mutating the user's real config (vibe has no
 * `--mcp-config` flag). Returns the dir, or null if vibe isn't set up (no
 * config.toml) — in which case the caller spawns vibe with its own defaults.
 *
 * The dir is UNIQUE per spawn: Octipus is always multi-user and CLI agents run
 * concurrently, and vibe writes per-run session state (history, logs, cache)
 * into VIBE_HOME — a shared dir would let concurrent agents corrupt each other's
 * config.toml mid-write and cross-contaminate session state. The caller is
 * responsible for removing the returned dir when the vibe process exits.
 */
function getOrCreateVibeHome(): string | null {
  const realHome = process.env.VIBE_HOME || join(homedir(), '.vibe');
  const realConfig = join(realHome, 'config.toml');
  // Nothing to seed if vibe was never set up — let vibe fall back to defaults
  // (it will still run, just without the Octipus MCP server).
  if (!existsSync(realConfig)) return null;

  const dir = join(tmpdir(), 'octipus-cli', `vibe-home-${randomBytes(8).toString('hex')}`);
  try {
    mkdirSync(dir, { recursive: true });

    // Seed creds + trust list into the fresh dir so vibe finds the API key.
    const realEnv = join(realHome, '.env');
    if (existsSync(realEnv)) copyFileSync(realEnv, join(dir, '.env'));
    const realTrust = join(realHome, 'trusted_folders.toml');
    if (existsSync(realTrust)) copyFileSync(realTrust, join(dir, 'trusted_folders.toml'));

    // Write config.toml with a fresh MCP launch (entry/port/token) merged in.
    const launch = resolveOctipusMcpLaunch();
    const merged = injectVibeMcpServer(readFileSync(realConfig, 'utf-8'), launch);
    writeFileSync(join(dir, 'config.toml'), merged);
    return dir;
  } catch (err) {
    coreLogger.warn({ err }, 'Failed to seed VIBE_HOME for Octipus MCP — vibe will run without it');
    return null;
  }
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
 * Builds CLI arguments for different agent tools (Claude Code, Antigravity, Codex, Mistral Vibe).
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
    maxTokenBudget?: number,
  ): { binary: string; args: string[]; stdinPrompt?: string; useShell?: boolean; env?: Record<string, string> } {
    switch (toolName) {
      case 'Claude Code':
        return this.buildClaudeArgs(prompt, settings, systemMessages);
      case 'Antigravity':
        return this.buildAntigravityArgs(prompt, settings, systemPrompt);
      case 'Codex CLI':
        return this.buildCodexArgs(prompt, systemPrompt, settings);
      case 'Mistral Vibe':
        return this.buildVibeArgs(prompt, settings, maxTokenBudget);
      default:
        throw new Error(`Unknown CLI tool: ${toolName}`);
    }
  }

  private buildVibeArgs(
    prompt: string,
    settings: CLIAgentConfig,
    maxTokenBudget?: number,
  ): { binary: string; args: string[]; stdinPrompt?: string; env?: Record<string, string> } {
    // vibe -p runs programmatic mode (send prompt → emit JSON message array →
    // exit). --trust skips the workdir trust prompt; --auto-approve allows tool
    // calls without blocking on approval. --output json is parsed at process
    // close (CLIToolConfig.bufferOutput) — `streaming` hangs in a non-interactive
    // pipe. Model is chosen by vibe's own config (active_model), not a flag.
    const args = ['-p'];

    // On Windows, shell:true re-tokenizes argv and mangles long/special-char
    // prompts; pipe via stdin instead (vibe reads the prompt from stdin when -p
    // is given no inline text). Linux/macOS spawn argv is safe — pass inline.
    if (!IS_WIN) {
      args.push(prompt);
    }

    args.push('--output', 'json', '--trust', '--auto-approve');

    // vibe reports no token/cost usage in its output, so the worker's
    // token-budget kill can't fire — let vibe self-limit via its caps instead.
    if (settings.maxBudgetUsd != null) {
      args.push('--max-price', String(settings.maxBudgetUsd));
    }
    if (maxTokenBudget && maxTokenBudget > 0) {
      args.push('--max-tokens', String(maxTokenBudget));
    }

    // allowedTools → vibe --enabled-tools (in -p mode this disables all others).
    if (settings.allowedTools?.length) {
      for (const tool of settings.allowedTools) {
        args.push('--enabled-tools', tool);
      }
    }

    if (settings.extraArgs?.length) {
      args.push(...settings.extraArgs);
    }

    // Point vibe at an ephemeral VIBE_HOME that registers the Octipus MCP server
    // (vibe has no --mcp-config flag). Null when vibe isn't set up — then it runs
    // with its own defaults and no Octipus MCP.
    const vibeHome = getOrCreateVibeHome();
    const env = vibeHome ? { VIBE_HOME: vibeHome } : undefined;

    return {
      binary: 'vibe',
      args,
      stdinPrompt: IS_WIN ? prompt : undefined,
      env,
    };
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

  private buildAntigravityArgs(
    prompt: string,
    settings: CLIAgentConfig,
    systemPrompt?: string | null,
  ): { binary: string; args: string[]; useShell?: boolean } {
    // agy (Antigravity) replaces the Gemini CLI. `--print <prompt>` runs a
    // single prompt non-interactively and emits PLAIN TEXT (no -o json /
    // stream-json), which the worker buffers via CLIToolConfig.bufferOutput.
    // --dangerously-skip-permissions auto-approves tool calls (the agy
    // equivalent of gemini's --approval-mode yolo).
    const args: string[] = ['--dangerously-skip-permissions'];

    // Model override: env var > settings. agy uses --model (not gemini's -m);
    // when unset, agy picks the model from its own ~/.gemini config.
    const model = process.env.ANTIGRAVITY_MODEL || process.env.GEMINI_MODEL || settings.model;
    if (model) {
      args.push('--model', model);
    }

    if (settings.extraArgs?.length) {
      args.push(...settings.extraArgs);
    }

    // agy has no --system-prompt flag. Prepend the expert system prompt to the
    // user prompt; the worker also writes it to GEMINI.md (which agy reads).
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    args.push('--print', fullPrompt);

    // agy is a native single binary (not a .cmd wrapper), so the worker must
    // NOT shell-wrap it on Windows — shell:true would re-tokenize the prompt
    // argv. Passing useShell:false keeps the prompt a single argv element.
    return { binary: 'agy', args, useShell: false };
  }

  /**
   * Write content to a temp file, returning the path.
   * Used on Windows to bypass the ~8191-char command-line limit.
   */
  private writeTempFile(prefix: string, content: string, ext: string = '.txt'): string {
    const dir = join(tmpdir(), 'octipus-cli');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${prefix}${randomBytes(6).toString('hex')}${ext}`);
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
    // Sandbox / approval policy: codex `exec` defaults to `--sandbox
    // read-only`, so spawned agents (e.g. pipeline architecture stages)
    // cannot write the ADRs / docs they produce. Mirror the write-enabled
    // defaults the Claude (`bypassPermissions`) and Gemini (`yolo`) CLI
    // adapters already use. Operators can downgrade to read-only by
    // setting permissionMode='read-only' on the model row.
    // Sandbox policy: `codex exec` is non-interactive (no approval prompts
    // to suppress) but it does honor `--sandbox`. Default is read-only,
    // which blocks pipeline stages from writing the docs/code they
    // produce — see Claude (`bypassPermissions`) and Gemini (`yolo`)
    // adapters above for the write-enabled equivalents. Operators can
    // dial back per-model via `permissionMode` on the model row.
    const codexPermMode = settings?.permissionMode || 'workspace-write';
    const baseArgs = [
      'exec',
      '--skip-git-repo-check',
      '--json',
      '--ephemeral',
      '--sandbox', codexPermMode,
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

    // Antigravity (agy) emits plain text buffered at process close
    // (CLIToolConfig.bufferOutput), so it has no per-event stream parser here.

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
