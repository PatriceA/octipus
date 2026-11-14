import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify } from 'smol-toml';

/** A managed Grok launch reads only its own config, login and session history. */
export function prepareGrokRuntime(options: {
  prompt: string;
  workspace: string;
  model?: string;
  maxTurns: number;
  resume?: { id: string; isFirstRun: boolean };
  mcp?: { runtime: string; entry: string; url: string; key: string };
  sourceHome?: string;
  authPath?: string;
  stateRoot?: string;
  temporaryRoot?: string;
}) {
  const sourceHome = options.sourceHome ?? (process.env.GROK_HOME || join(homedir(), '.grok'));
  const authPath = resolve(options.authPath ?? (process.env.GROK_AUTH_PATH || join(sourceHome, 'auth.json')));
  const stateRoot = options.stateRoot ?? join(homedir(), '.octipus', 'grok-build');
  const identity = createHash('sha256').update(authPath).update('\0').update(resolve(options.workspace)).digest('hex');
  const state = join(stateRoot, identity);
  const cwd = join(state, 'work');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  // Stop discovery at this empty workspace; the actual project is reached only
  // through Octipus tools. No project/vendor MCP, plugins or hooks are loaded.
  mkdirSync(join(cwd, '.git'), { mode: 0o700, recursive: true });
  mkdirSync(join(state, 'sessions'), { mode: 0o700, recursive: true });
  const root = options.temporaryRoot ?? join(tmpdir(), 'octipus-cli');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(join(root, 'grok-'));
  const home = join(temporary, '.grok');
  try {
    mkdirSync(home, { mode: 0o700 });
    // GROK_AUTH_PATH keeps the vendor's original refresh lock and atomic writes
    // together. A symlinked auth.json would split them when Grok replaces it.
    symlinkSync(join(state, 'sessions'), join(home, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
    const compat = Object.fromEntries(['claude', 'cursor', 'codex'].map(vendor => [vendor,
      { skills: false, rules: false, agents: false, mcps: false, hooks: false, sessions: false }]));
    const config = {
      cli: { auto_update: false, use_leader: false },
      compat,
      subagents: { enabled: false },
      memory: { enabled: false },
      mcp_servers: options.mcp ? { octipus: {
        command: options.mcp.runtime, args: [options.mcp.entry],
        env: { OCTIPUS_AGENT_URL: options.mcp.url, OCTIPUS_AGENT_KEY: options.mcp.key },
        startup_timeout_sec: 30, tool_timeout_sec: 7200,
      } } : {},
    };
    writeFileSync(join(home, 'config.toml'), stringify(config), { mode: 0o600 });
    writeFileSync(join(home, 'managed_config.toml'), 'allow_managed_hooks_only = true\n', { mode: 0o600 });
    const promptFile = join(home, 'prompt.txt');
    writeFileSync(promptFile, options.prompt, { mode: 0o600 });
    const args = ['--no-leader', '--prompt-file', promptFile, '--output-format', 'streaming-messages-json',
      '--tools', 'search_tool,use_tool', '--no-subagents', '--disable-web-search', '--always-approve', '--max-turns', String(options.maxTurns)];
    if (options.model) args.push('--model', options.model);
    const session = options.resume ?? { id: randomUUID(), isFirstRun: true };
    args.push(session.isFirstRun ? '--session-id' : '--resume', session.id);
    return { binary: 'grok', args, cwd, useShell: false, env: {
      HOME: temporary, USERPROFILE: temporary, XDG_CONFIG_HOME: join(temporary, '.config'), GROK_HOME: home, GROK_AUTH_PATH: authPath, GROK_LOGIN_ENV: '0', GROK_MANAGED_MCPS_ENABLED: '0', GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: '0',
    }, cleanupPaths: [temporary] };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw new Error('Cannot prepare isolated Grok Build runtime. Check runtime-directory permissions and support for transcript directory links.', { cause: error });
  }
}

/** Refuse a vendor build that ignored the managed tool restrictions. */
export function grokToolIsolationError(event: Record<string, unknown>): string | undefined {
  const tools = event.tools;
  const servers = event.mcp_servers;
  if (!Array.isArray(tools) || !Array.isArray(servers)
    || tools.some((tool: unknown) => typeof tool !== 'string' || !['search_tool', 'use_tool'].includes(tool) && !tool.startsWith('octipus__'))
    || servers.some((server: unknown) => !server || typeof server !== 'object' || !('name' in server) || server.name !== 'octipus')) {
    return 'Grok Build did not honour scoped tool isolation. The run was stopped; check the installed Grok CLI version.';
  }
  return undefined;
}
