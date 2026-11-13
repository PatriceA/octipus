import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { prepareGrokRuntime, grokToolIsolationError } from './grok-cli-runtime';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'grok runtime ')); roots.push(root);
  const sourceHome = join(root, 'existing-login'); mkdirSync(sourceHome);
  writeFileSync(join(sourceHome, 'auth.json'), '{"test":"fixture"}');
  writeFileSync(join(sourceHome, 'config.toml'), '[mcp_servers.unrelated]\ncommand = "do-not-run"\n');
  return { root, sourceHome, options: { prompt: 'multiline\n$()`" prompt', workspace: join(root, 'project'), maxTurns: 7,
    sourceHome, authPath: join(sourceHome, 'auth.json'), stateRoot: join(root, 'state'), temporaryRoot: join(root, 'temporary') } };
}

describe('isolated Grok Build runtime', () => {
  it('shares the vendor login path and transcripts; host/project configuration never enters the runtime', () => {
    const { sourceHome, options } = setup();
    const run = prepareGrokRuntime({ ...options, mcp: { runtime: '/node', entry: '/mcp.js', url: 'http://127.0.0.1:4567', key: 'scoped-fixture' } });
    expect(run.env.HOME).not.toBe(process.env.HOME);
    expect(run.env.USERPROFILE).toBe(run.env.HOME);
    expect(run.env.GROK_AUTH_PATH).toBe(join(sourceHome, 'auth.json'));
    expect(existsSync(join(run.env.GROK_HOME, 'auth.json'))).toBe(false);
    const config = parse(readFileSync(join(run.env.GROK_HOME, 'config.toml'), 'utf8'));
    expect(Object.keys(config.mcp_servers as object)).toEqual(['octipus']);
    expect(config).toMatchObject({ compat: { claude: { mcps: false, hooks: false }, cursor: { mcps: false } },
      mcp_servers: { octipus: { env: { OCTIPUS_AGENT_URL: 'http://127.0.0.1:4567', OCTIPUS_AGENT_KEY: 'scoped-fixture' } } } });
    expect(readFileSync(join(run.env.GROK_HOME, 'managed_config.toml'), 'utf8')).toContain('allow_managed_hooks_only = true');
    expect(run.cwd).not.toBe(options.workspace);
    expect(existsSync(join(run.cwd, '.git'))).toBe(true);
    expect(run.args[run.args.indexOf('--tools') + 1]).toBe('search_tool,use_tool');
    expect(run.args).not.toContain(options.prompt);
    expect(readFileSync(run.args[run.args.indexOf('--prompt-file') + 1], 'utf8')).toBe(options.prompt);
    expect(run.useShell).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(run.env.HOME).mode & 0o777).toBe(0o700);
      expect(statSync(join(run.env.GROK_HOME, 'config.toml')).mode & 0o777).toBe(0o600);
    }
    for (const path of run.cleanupPaths) rmSync(path, { recursive: true, force: true });
    expect(readFileSync(join(sourceHome, 'auth.json'), 'utf8')).toBe('{"test":"fixture"}');
  });

  it('rotates bridge config while resuming the same transcript and isolates other projects', () => {
    const { options } = setup();
    const first = prepareGrokRuntime({ ...options, resume: { id: 'test-session', isFirstRun: true } });
    const second = prepareGrokRuntime({ ...options, resume: { id: 'test-session', isFirstRun: false } });
    const other = prepareGrokRuntime({ ...options, workspace: options.workspace + '-other' });
    expect(first.cwd).toBe(second.cwd);
    expect(first.env.GROK_HOME).not.toBe(second.env.GROK_HOME);
    expect(readlinkSync(join(first.env.GROK_HOME, 'sessions'))).toBe(readlinkSync(join(second.env.GROK_HOME, 'sessions')));
    expect(other.cwd).not.toBe(first.cwd);
    expect(first.args).toContain('--session-id');
    expect(second.args).toContain('--resume');
    expect(second.args).not.toContain('--session-id');
  });

  it('does not synthesize login credentials when no login exists', () => {
    const { sourceHome, options } = setup(); rmSync(join(sourceHome, 'auth.json'));
    const run = prepareGrokRuntime(options);
    expect(existsSync(join(run.env.GROK_HOME, 'auth.json'))).toBe(false);
  });
});

describe('Grok advertised tool isolation', () => {
  it('accepts scoped discovery helpers and only the Octipus MCP server', () => {
    expect(grokToolIsolationError({ tools: ['search_tool', 'use_tool', 'octipus__shell__run'], mcp_servers: [{ name: 'octipus', status: 'pending' }] })).toBeUndefined();
  });
  it.each([
    { tools: ['run_terminal_command'], mcp_servers: [] },
    { tools: ['search_tool'], mcp_servers: [{ name: 'workstation-server' }] },
    { tools: ['search_tool'] },
    { tools: [null], mcp_servers: [] },
  ])('refuses ignored flags or incomplete isolation metadata: %j', event => {
    expect(grokToolIsolationError(event)).toContain('did not honour scoped tool isolation');
  });
});
