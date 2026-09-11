import { parse as parseToml } from 'smol-toml';
import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIArgumentBuilder, discoverCodexMcpServers, injectVibeMcpServer, resolveCodexSandboxMode, resolveVibeMode } from './cli-adapters';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
const mockCodexList = (stdout: string | Error) => vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
  stdout instanceof Error ? cb(stdout, '', 'sensitive stdout and stderr') : cb(null, stdout, '');
  return undefined as never;
}) as never);

const builder = new CLIArgumentBuilder();

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
  vi.clearAllMocks();
});

describe('CLIArgumentBuilder model override', () => {
  it('Claude Code: passes --model when settings.model is set', () => {
    delete process.env.CLAUDE_MODEL;
    const out = builder.build('Claude Code', 'hi', { model: 'sonnet' }, []);
    const i = out.args.indexOf('--model');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(out.args[i + 1]).toBe('sonnet');
  });

  it('Claude Code: env CLAUDE_MODEL beats settings.model', () => {
    process.env.CLAUDE_MODEL = 'opus';
    const out = builder.build('Claude Code', 'hi', { model: 'sonnet' }, []);
    const i = out.args.indexOf('--model');
    expect(out.args[i + 1]).toBe('opus');
  });

  it('Claude Code: omits --model entirely when neither set', () => {
    delete process.env.CLAUDE_MODEL;
    const out = builder.build('Claude Code', 'hi', {}, []);
    expect(out.args.includes('--model')).toBe(false);
  });

  // Antigravity (agy) replaces the Gemini CLI: native binary, --model flag,
  // --print plain-text output, --dangerously-skip-permissions.
  it('Antigravity: passes --model when settings.model is set', () => {
    delete process.env.GEMINI_MODEL;
    delete process.env.ANTIGRAVITY_MODEL;
    const out = builder.build('Antigravity', 'hi', { model: 'gemini-3-pro' }, []);
    expect(out.binary).toBe('agy');
    const i = out.args.indexOf('--model');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(out.args[i + 1]).toBe('gemini-3-pro');
  });

  it('Antigravity: env ANTIGRAVITY_MODEL beats settings.model', () => {
    process.env.ANTIGRAVITY_MODEL = 'gemini-3-flash';
    const out = builder.build('Antigravity', 'hi', { model: 'gemini-3-pro' }, []);
    const i = out.args.indexOf('--model');
    expect(out.args[i + 1]).toBe('gemini-3-flash');
  });

  it('Antigravity: omits --model entirely when neither set', () => {
    delete process.env.GEMINI_MODEL;
    delete process.env.ANTIGRAVITY_MODEL;
    const out = builder.build('Antigravity', 'hi', {}, []);
    expect(out.args.includes('--model')).toBe(false);
  });

  it('Antigravity: uses --print plain-text mode with auto-approve and no shell wrap', () => {
    delete process.env.GEMINI_MODEL;
    delete process.env.ANTIGRAVITY_MODEL;
    const out = builder.build('Antigravity', 'do the thing', {}, []);
    expect(out.args).toContain('--dangerously-skip-permissions');
    const p = out.args.indexOf('--print');
    expect(p).toBeGreaterThanOrEqual(0);
    expect(out.args[p + 1]).toBe('do the thing');
    expect(out.useShell).toBe(false);
  });

  it('Antigravity: prepends the system prompt to the user prompt', () => {
    const out = builder.build('Antigravity', 'user ask', {}, [], 'SYSTEM RULES');
    const p = out.args.indexOf('--print');
    expect(out.args[p + 1]).toBe('SYSTEM RULES\n\nuser ask');
  });

  it('Codex CLI: settings.model overrides default', () => {
    delete process.env.CODEX_MODEL;
    const out = builder.build('Codex CLI', 'hi', { model: 'gpt-5.5' }, []);
    const idx = out.args.findIndex(a => a.startsWith('model='));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(out.args[idx]).toBe('model="gpt-5.5"');
  });

  it('Codex CLI: env CODEX_MODEL beats settings.model', () => {
    process.env.CODEX_MODEL = 'o3';
    const out = builder.build('Codex CLI', 'hi', { model: 'gpt-5.5' }, []);
    const idx = out.args.findIndex(a => a.startsWith('model='));
    expect(out.args[idx]).toBe('model="o3"');
  });

  it('Codex CLI: no -c model override when neither env nor settings set it', () => {
    delete process.env.CODEX_MODEL;
    const out = builder.build('Codex CLI', 'hi', {}, []);
    // No model forced from Octipus — codex resolves it from ~/.codex/config.toml.
    expect(out.args.some(a => a.startsWith('model='))).toBe(false);
    expect(out.args).not.toContain('-c');
  });
});

describe('CLIArgumentBuilder Mistral Vibe args', () => {
  // Point VIBE_HOME at a dir with no config.toml so getOrCreateVibeHome() returns
  // null and the args are deterministic (no env injected).
  const withoutVibeHome = () => {
    process.env.VIBE_HOME = '/nonexistent-octipus-vibe-home';
  };

  it('builds the programmatic invocation with trust + auto-approve + json output', () => {
    withoutVibeHome();
    const out = builder.build('Mistral Vibe', 'do the thing', {}, []);
    expect(out.binary).toBe('vibe');
    // Non-Windows: prompt is positional right after -p.
    expect(out.args[0]).toBe('-p');
    expect(out.args[1]).toBe('do the thing');
    expect(out.args).toContain('--output');
    expect(out.args).toContain('json');
    expect(out.args).toContain('--trust');
    expect(out.args).toContain('--agent');
    expect(out.args).toContain('auto-approve');
  });

  it('does NOT pass a model flag (vibe selects model via its own config)', () => {
    withoutVibeHome();
    const out = builder.build('Mistral Vibe', 'hi', { model: 'mistral-large-latest' }, []);
    expect(out.args).not.toContain('--model');
    expect(out.args).not.toContain('-m');
  });

  it('maps maxBudgetUsd → --max-price and the token budget → --max-tokens', () => {
    withoutVibeHome();
    const out = builder.build('Mistral Vibe', 'hi', { maxBudgetUsd: 0.5 }, [], null, 20000);
    const priceIdx = out.args.indexOf('--max-price');
    expect(priceIdx).toBeGreaterThanOrEqual(0);
    expect(out.args[priceIdx + 1]).toBe('0.5');
    const tokIdx = out.args.indexOf('--max-tokens');
    expect(tokIdx).toBeGreaterThanOrEqual(0);
    expect(out.args[tokIdx + 1]).toBe('20000');
  });

  it('maps each allowedTools entry to a repeated --enabled-tools flag', () => {
    withoutVibeHome();
    const out = builder.build('Mistral Vibe', 'hi', { allowedTools: ['read', 'grep'] }, []);
    const flags = out.args.filter((a) => a === '--enabled-tools');
    expect(flags.length).toBe(2);
    expect(out.args).toContain('read');
    expect(out.args).toContain('grep');
  });

  it('omits budget/tool flags when unset', () => {
    withoutVibeHome();
    const out = builder.build('Mistral Vibe', 'hi', {}, []);
    expect(out.args).not.toContain('--max-price');
    expect(out.args).not.toContain('--max-tokens');
    expect(out.args).not.toContain('--enabled-tools');
  });
});

describe('injectVibeMcpServer', () => {
  const launch = {
    runtime: 'node',
    entry: '/opt/octipus/mcp-server/dist/index.js',
    apiUrl: 'http://127.0.0.1:3005',
    apiKey: 'tok-abc',
  };

  it('replaces an empty mcp_servers array exactly once with the octipus entry', () => {
    const cfg = 'active_model = "mistral-medium-3.5"\nmcp_servers = []\nenable_telemetry = true\n';
    const out = injectVibeMcpServer(cfg, launch);
    expect(parseToml(out).mcp_servers).toHaveLength(1);
    expect(out).toContain('name = "octipus"');
    expect(out).toContain('transport = "stdio"');
    expect(out).toContain('"/opt/octipus/mcp-server/dist/index.js"');
    expect(out).toContain('OCTIPUS_API_KEY = "tok-abc"');
    // Surrounding config is preserved.
    expect(out).toContain('active_model = "mistral-medium-3.5"');
    expect(out).toContain('enable_telemetry = true');
  });

  it('omits OCTIPUS_API_KEY from env when no token is available', () => {
    const out = injectVibeMcpServer('mcp_servers = []\n', { ...launch, apiKey: '' });
    expect(out).toContain('OCTIPUS_URL = "http://127.0.0.1:3005"');
    expect(out).not.toContain('OCTIPUS_API_KEY');
  });

  it('appends an assignment when no inline mcp_servers line exists', () => {
    const out = injectVibeMcpServer('active_model = "x"\n', launch);
    expect(parseToml(out).mcp_servers).toHaveLength(1);
    expect(out).toContain('name = "octipus"');
  });
});

describe('run-scoped CLI configuration', () => {
  const connection = { url: 'http://127.0.0.1:43123', key: 'test-capability', planMode: true, maxIterations: 7, workingDirectory: '/session/project', codexMcpServers: [] as Array<{ name: string }> };
  it('maps plan mode and keeps the capability out of Codex argv', () => {
    const codex = builder.build('Codex CLI', 'task', { permissionMode: 'full' }, [], null, 100, 'test', connection);
    expect(codex.args[codex.args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(codex.args.join(' ')).toContain('octipus_run_');
    expect(codex.args.join(' ')).toContain('OCTIPUS_AGENT_KEY');
    expect(codex.args.join(' ')).not.toContain(connection.key);
    const claude = builder.build('Claude Code', 'task', { permissionMode: 'full' }, [], null, 100, 'test', connection);
    expect(claude.args[claude.args.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(claude.args).toContain('--strict-mcp-config');
    expect(claude.args[claude.args.indexOf('--max-turns') + 1]).toBe('7');
    expect(claude.env).toEqual({ MCP_TOOL_TIMEOUT: '7200000' });
    const agy = builder.build('Antigravity', 'task', { permissionMode: 'full' }, [], null, 100, 'test', connection);
    expect(agy.args).toContain('plan');
    expect(agy.args).not.toContain('--dangerously-skip-permissions');
  });

  it('disables every effective MCP entry, including project servers and quoted names', () => {
    const codexMcpServers = [{ name: 'host' }, { name: 'project.server' }, { name: 'quoted"server' }];
    const out = builder.build('Codex CLI', 'task', {}, [], null, 100, 'test', { ...connection, codexMcpServers });
    const overrides = parseToml(out.args.find(arg => arg.startsWith('mcp_servers='))!);
    expect(overrides.mcp_servers).toMatchObject({ host: { enabled: false }, 'project.server': { enabled: false }, 'quoted"server': { enabled: false } });
    const servers = overrides.mcp_servers as Record<string, unknown>;
    expect(Object.keys(servers).filter(name => name.startsWith('octipus_run_'))).toHaveLength(1);
  });

  it('refuses a scoped Codex launch without discovered configuration', () => {
    expect(() => builder.build('Codex CLI', 'task', {}, [], null, 100, 'test', { ...connection, codexMcpServers: undefined })).toThrow('refusing to launch an unscoped CLI run');
  });

  it.each([undefined, 'relative/project'])('discovery refuses a non-absolute cwd (%s)', async workingDirectory => {
    await expect(discoverCodexMcpServers(workingDirectory as string)).rejects.toThrow('absolute session working directory');
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each(['null', '{}', '[{"name":""}]', '[{"name":4}]', '[null]'])('discovery rejects malformed effective configuration (%s)', async value => {
    mockCodexList(value);
    await expect(discoverCodexMcpServers('/session/project')).rejects.toThrow('Invalid Codex MCP configuration listing');
  });

  it('discovery probes the same subscription home without inheriting backend credentials', async () => {
    process.env.CODEX_HOME = '/account/codex';
    process.env.OPENAI_API_KEY = 'backend-api-secret';
    process.env.DATABASE_URL = 'backend-db-secret';
    mockCodexList('[{"name":"host","enabled":true}]');
    await expect(discoverCodexMcpServers('/session/project')).resolves.toEqual([{ name: 'host' }]);
    expect(execFile).toHaveBeenCalledWith('codex', ['mcp', 'list', '--json'], expect.objectContaining({
      cwd: '/session/project', timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
      env: expect.objectContaining({ CODEX_HOME: '/account/codex' }),
    }), expect.any(Function));
    const options = vi.mocked(execFile).mock.calls[0][2] as { env: Record<string, string> };
    expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(options.env).not.toHaveProperty('DATABASE_URL');
  });

  it('discovery fails closed without exposing subprocess output', async () => {
    mockCodexList(new Error('sensitive stdout and stderr'));
    let thrown: unknown;
    try { await discoverCodexMcpServers('/session/project'); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain('refusing to launch an unscoped CLI run');
    expect(String(thrown)).not.toContain('sensitive');
    expect(thrown).not.toHaveProperty('cause');
  });

  it.each([
    ['Codex CLI', ['-c', 'mcp_servers.other.enabled=true']],
    ['Codex CLI', ['-cmcp_servers.other.enabled=true']],
    ['Codex CLI', ['--config=mcp_servers.other.enabled=true']],
    ['Codex CLI', ['--profile', 'other']],
    ['Codex CLI', ['-pother']],
    ['Codex CLI', ['-C', '/different/project']],
    ['Codex CLI', ['--cd=/different/project']],
    ['Codex CLI', ['--dangerously-bypass-approvals-and-sandbox']],
    ['Codex CLI', ['--', 'resume']],
    ['Claude Code', ['--mcp-config', 'other.json']],
    ['Claude Code', ['--strict-mcp-config=false']],
    ['Claude Code', ['--permission-mode=bypassPermissions']],
    ['Claude Code', ['--dangerously-skip-permissions']],
    ['Claude Code', ['--input-format', 'text']],
    ['Claude Code', ['--output-format=json']],
    ['Claude Code', ['--max-turns', '999']],
    ['Claude Code', ['--settings', 'other.json']],
    ['Mistral Vibe', ['--config', 'other.toml']],
    ['Mistral Vibe', ['--agent', 'auto-approve']],
    ['Mistral Vibe', ['--max-tokens=9999999']],
    ['Mistral Vibe', ['--enabled-tools', '*']],
    ['Mistral Vibe', ['--workdir', '/different/project']],
    ['Antigravity', ['--mode=accept-edits']],
    ['Antigravity', ['--dangerously-skip-permissions']],
    ['Antigravity', ['--project', 'other']],
    ['Antigravity', ['--output-format', 'stream-json']],
    ['Claude Code', ['--effort']],
    ['Claude Code', ['--effort=high', '--permission-mode=auto']],
    ['Codex CLI', ['--color', '--config=override']],
    ['Codex CLI', ['--color=never', 'resume']],
  ])('rejects scoped extraArgs overrides for %s: %j', (toolName, extraArgs) => {
    expect(() => builder.build(toolName as string, 'task', { extraArgs: extraArgs as string[] }, [], null, 100, 'test', connection)).toThrow('Unsupported extraArgs');
  });

  it.each([
    ['Claude Code', ['--no-session-persistence', '--effort=high']],
    ['Codex CLI', ['--strict-config', '--color', 'never']],
    ['Antigravity', ['--disable-slash-commands', '--effort', 'medium']],
  ])('preserves supported additive extraArgs for %s', (toolName, extraArgs) => {
    const out = builder.build(toolName as string, 'task', { extraArgs: extraArgs as string[] }, [], null, 100, 'test', connection);
    for (const arg of extraArgs) expect(out.args).toContain(arg);
  });

  it('leaves legacy unscoped argument handling available', () => {
    const out = builder.build('Codex CLI', 'task', { extraArgs: ['--profile', 'operator-choice'] }, []);
    expect(out.args).toContain('--profile');
    expect(out.args).toContain('operator-choice');
  });
});

it('preserves legacy permission aliases', () => {
  expect(resolveCodexSandboxMode('auto')).toBe('workspace-write');
  expect(resolveVibeMode('yolo')).toBe('auto-approve');
  expect(resolveVibeMode('auto_edit')).toBe('accept-edits');
  const yolo = builder.build('Antigravity', 'task', { permissionMode: 'yolo' }, []);
  expect(yolo.args).toContain('--dangerously-skip-permissions');
  const edits = builder.build('Antigravity', 'task', { permissionMode: 'auto_edit' }, []);
  expect(edits.args).toContain('accept-edits');
  expect(edits.args).toContain('--sandbox');
});

it('isolates Vibe MCP servers while preserving model configuration', () => {
  const config = 'active_model = "user-choice"\n[[mcp_servers]]\nname = "other"\ncommand = "other-tool"\n[[mcp_servers]]\nname = "octipus"\ncommand = "stale"\n';
  const result = parseToml(injectVibeMcpServer(config, { runtime: 'node', entry: '/test/index.js', apiUrl: 'http://127.0.0.1:1', apiKey: 'run-key' }, true));
  expect(result.active_model).toBe('user-choice');
  expect(result.mcp_servers).toEqual([
    { name: 'octipus', command: 'node', transport: 'stdio', args: ['/test/index.js'], tool_timeout_sec: 7200, env: { OCTIPUS_AGENT_URL: 'http://127.0.0.1:1', OCTIPUS_AGENT_KEY: 'run-key' } },
  ]);
});
