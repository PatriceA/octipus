import { validateScopedExtraArgs } from '@/shared/cli-capabilities';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const AGY_MANAGED_AGENT = 'octipus-managed';
export interface AgyRuntimeOptions {
  workspace: string;
  instructions: string;
  model?: string;
  apiKeyMode?: boolean;
  extraArgs?: string[];
  resume?: { id: string; isFirstRun: boolean };
  mcp?: { runtime: string; entry: string; url: string; key: string };
  sourceGeminiDir?: string;
  stateRoot?: string;
  temporaryRoot?: string;
}

/** Isolate customizations while retaining only the existing login and our conversations. */
export function prepareAgyRuntime(options: AgyRuntimeOptions) {
  validateScopedExtraArgs('Antigravity', options.extraArgs ?? []);
  const source = resolve(options.sourceGeminiDir ?? process.env.ANTIGRAVITY_GEMINI_DIR ?? join(homedir(), '.gemini'));
  const identity = createHash('sha256').update(source).update('\0').update(resolve(options.workspace)).digest('hex');
  const state = join(options.stateRoot ?? join(homedir(), '.octipus', 'antigravity'), identity);
  const cwd = join(state, 'work');
  mkdirSync(join(cwd, '.git'), { recursive: true, mode: 0o700 });
  // Link the directory, not individual credential files: native refresh locks
  // and atomic token replacement then use the original account store.
  const originalApp = join(source, 'antigravity-cli');
  const app = existsSync(originalApp) ? originalApp : join(state, 'unsigned-application');
  if (!existsSync(app)) mkdirSync(app, { recursive: true, mode: 0o700 });
  const root = options.temporaryRoot ?? join(tmpdir(), 'octipus-cli');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const home = mkdtempSync(join(root, 'agy-'));
  try {
    const gemini = join(home, '.gemini');
    mkdirSync(join(gemini, 'config', 'agents'), { recursive: true, mode: 0o700 });
    symlinkSync(app, join(gemini, 'antigravity-cli'), process.platform === 'win32' ? 'junction' : 'dir');
    const mcpServers = options.mcp ? [{ name: 'octipus', command: options.mcp.runtime, args: [options.mcp.entry],
      env: {}, timeoutSeconds: 7200 }] : [];
    // AGY custom-agent tools are native component names. MCPs belong in their
    // own field, not tools[]. An empty native list removes shell and spawning.
    const definition = { name: AGY_MANAGED_AGENT, description: 'Execute work using the scoped Octipus tools',
      mainAgent: true, subagent: false, tools: [], mcpServers };
    writeFileSync(join(gemini, 'config', 'agents', `${AGY_MANAGED_AGENT}.md`),
      `---\n${JSON.stringify(definition)}\n---\n${options.instructions}\n`, { mode: 0o600 });
    const settingsPath = join(home, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ toolPermission: 'always-proceed',
      model: '', modelProvider: options.apiKeyMode ? 'gemini' : '', customModelsConfig: {},
      agentMode: '', disableSlashCommands: true, artifactReviewPolicy: 'always-proceed', notifications: false, statusLine: false, title: false,
      permissions: { allow: [], ask: [], deny: ['command(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)'] },
    }), { mode: 0o600 });
    const args = ['--settings', settingsPath, '--agent', AGY_MANAGED_AGENT, '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--dangerously-skip-permissions', '--disable-slash-commands'];
    if (options.model) args.push('--model', options.model);
    if (options.resume && !options.resume.isFirstRun) args.push('--conversation', options.resume.id);
    args.push(...(options.extraArgs ?? []).filter(arg => arg !== '--disable-slash-commands'));
    return { binary: 'agy', args, cwd, useShell: false, env: { HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'), ANTIGRAVITY_GEMINI_DIR: gemini, AGY_CLI_DISABLE_AUTO_UPDATE: '1',
      ...(options.mcp ? { OCTIPUS_AGENT_URL: options.mcp.url, OCTIPUS_AGENT_KEY: options.mcp.key } : {}) },
      cleanupPaths: [home], settingsPath };
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw new Error('Cannot prepare isolated Antigravity runtime; check runtime paths and credential-link permissions.', { cause: error });
  }
}

/** AGY init advertises the entire registry, not the custom agent's effective tools. */
export function agyIsolationError(event: Record<string, unknown>, cwd: string, expectedConversation?: string): string | undefined {
  if (event.event === 'init') {
    const init = event.init as Record<string, unknown> | undefined;
    if (expectedConversation && event.conversation_id !== expectedConversation) return 'Antigravity session not found: the CLI opened a different conversation instead of resuming.';
    if (init?.agent !== AGY_MANAGED_AGENT || init.cwd !== cwd || (typeof event.conversation_id !== 'string' || !event.conversation_id.trim())) {
      return 'Antigravity did not load the isolated Octipus agent.';
    }
  }
  if (event.event === 'step_update') {
    const step = event.step_update as Record<string, unknown> | undefined;
    if (step?.subagent_info) return 'Antigravity attempted native agent spawning outside Octipus.';
    if (step?.step_type === 'tool') {
      const info = step.tool_info as { parameters?: { ServerName?: unknown } } | undefined;
      if (step.tool_name !== 'call_mcp_tool' || info?.parameters?.ServerName !== 'octipus') {
        return 'Antigravity attempted a tool outside the scoped Octipus server.';
      }
    }
  }
  return undefined;
}

