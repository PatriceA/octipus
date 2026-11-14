import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGY_MANAGED_AGENT, agyIsolationError, prepareAgyRuntime } from './agy-cli-runtime';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agy runtime ')); roots.push(root);
  const sourceGeminiDir = join(root, 'source'); mkdirSync(join(sourceGeminiDir, 'antigravity-cli'), { recursive: true });
  writeFileSync(join(sourceGeminiDir, 'antigravity-cli', 'jetski_state.pbtxt'), 'fixture-only');
  return { sourceGeminiDir, options: { workspace: '/project', instructions: 'Trusted system instructions', sourceGeminiDir,
    stateRoot: join(root, 'state'), temporaryRoot: join(root, 'temporary') } };
}
describe('managed Antigravity runtime', () => {
  it('loads only an empty native tool set and the run-scoped Octipus server', () => {
    const { sourceGeminiDir, options } = setup();
    const run = prepareAgyRuntime({ ...options, mcp: { runtime: '/node', entry: '/mcp.js', url: 'http://127.0.0.1:1234', key: 'scoped-test' } });
    const definitionPath = join(run.env.ANTIGRAVITY_GEMINI_DIR, 'config', 'agents', `${AGY_MANAGED_AGENT}.md`);
    const definition = readFileSync(definitionPath, 'utf8');
    const agent = JSON.parse(definition.split('\n')[1]);
    expect(agent).toMatchObject({ name: AGY_MANAGED_AGENT, tools: [], subagent: false,
      mcpServers: [{ name: 'octipus', env: {} }] });
    expect(definition).toContain(options.instructions);
    expect(run.args.join(' ')).not.toContain('scoped-test');
    expect(run.env.HOME).not.toBe(process.env.HOME);
    expect(run.cwd).not.toBe(options.workspace);
    expect(run.args).toContain('--input-format'); expect(run.args).not.toContain('--print');
    const app = join(run.env.ANTIGRAVITY_GEMINI_DIR, 'antigravity-cli');
    expect(readlinkSync(app)).toBe(join(sourceGeminiDir, 'antigravity-cli'));
    expect(run.env.OCTIPUS_AGENT_KEY).toBe('scoped-test');
    expect(definition).not.toContain('scoped-test');
    if (process.platform !== 'win32') expect(statSync(definitionPath).mode & 0o777).toBe(0o600);
    for (const path of run.cleanupPaths) rmSync(path, { recursive: true, force: true });
    expect(readFileSync(join(sourceGeminiDir, 'antigravity-cli', 'jetski_state.pbtxt'), 'utf8')).toBe('fixture-only');
  });
  it('persists conversations while rotating config and preserves a captured resume ID', () => {
    const { options } = setup();
    const first = prepareAgyRuntime(options);
    const second = prepareAgyRuntime({ ...options, resume: { id: 'vendor-id', isFirstRun: false }, extraArgs: ['--effort', 'max'] });
    expect(first.cwd).toBe(second.cwd);
    expect(first.env.HOME).not.toBe(second.env.HOME);
    expect(readlinkSync(join(first.env.ANTIGRAVITY_GEMINI_DIR, 'antigravity-cli'))).toBe(readlinkSync(join(second.env.ANTIGRAVITY_GEMINI_DIR, 'antigravity-cli')));
    expect(second.args).toContain('--conversation'); expect(second.args).toContain('vendor-id'); expect(second.args).toContain('max');
    const state = readlinkSync(join(first.env.ANTIGRAVITY_GEMINI_DIR, 'antigravity-cli'));
    for (const path of first.cleanupPaths) rmSync(path, { recursive: true, force: true });
    expect(existsSync(state)).toBe(true);
  });
  it('keeps concurrent auth selections private and leaves native settings untouched', () => {
    const { sourceGeminiDir, options } = setup();
    const original = join(sourceGeminiDir, 'antigravity-cli', 'settings.json');
    const content = JSON.stringify({ modelProvider: 'existing', statusLine: { command: 'do-not-run' } });
    writeFileSync(original, content);
    const oauth = prepareAgyRuntime(options);
    const api = prepareAgyRuntime({ ...options, apiKeyMode: true });
    expect(oauth.settingsPath).not.toBe(api.settingsPath);
    expect(JSON.parse(readFileSync(oauth.settingsPath, 'utf8'))).toMatchObject({ modelProvider: '', statusLine: false, title: false });
    expect(JSON.parse(readFileSync(api.settingsPath, 'utf8')).modelProvider).toBe('gemini');
    expect(readFileSync(original, 'utf8')).toBe(content);
    expect(() => prepareAgyRuntime({ ...options, extraArgs: ['--agent', 'untrusted'] })).toThrow();
  });
  it('selects API-key mode only when explicitly requested', () => {
    const { options } = setup(); const run = prepareAgyRuntime({ ...options, apiKeyMode: true });
    expect(JSON.parse(readFileSync(run.settingsPath, 'utf8')).modelProvider).toBe('gemini');
  });
});
describe('Antigravity startup and native action checks', () => {
  it('checks the selected managed agent and conversation identity, not the misleading full registry list', () => {
    const init = { event: 'init', conversation_id: 'saved-id', init: { agent: AGY_MANAGED_AGENT, cwd: '/runtime', tools: ['run_command'] } };
    expect(agyIsolationError(init, '/runtime', 'saved-id')).toBeUndefined();
    expect(agyIsolationError(init, '/runtime', 'other-id')).toContain('session not found');
    expect(agyIsolationError(init, '/other')).toContain('isolated Octipus agent');
  });
  it('rejects native tools, external MCP servers and native agents', () => {
    for (const step of [{ step_type: 'tool', tool_name: 'run_command' },
      { step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { parameters: { ServerName: 'host' } } }, { subagent_info: {} }]) {
      expect(agyIsolationError({ event: 'step_update', step_update: step }, '/runtime')).toBeTruthy();
    }
    expect(agyIsolationError({ event: 'step_update', step_update: { step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { parameters: { ServerName: 'octipus' } } } }, '/runtime')).toBeUndefined();
  });
});
