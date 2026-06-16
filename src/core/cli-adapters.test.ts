import { afterEach, describe, expect, it } from 'bun:test';
import { CLIArgumentBuilder, injectVibeMcpServer } from './cli-adapters';

const builder = new CLIArgumentBuilder();

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
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

  // For Gemini we inspect `geminiArgs` (the underlying gemini.cmd argv)
  // instead of `args` — on Windows the spawn target is powershell.exe
  // wrapping a generated .ps1, so `args` carries only the PS shim. The
  // flag construction we care about (-m / -p / --approval-mode) lives
  // in `geminiArgs` on both platforms.
  it('Gemini CLI: passes -m when settings.model is set', () => {
    delete process.env.GEMINI_MODEL;
    const out = builder.build('Gemini CLI', 'hi', { model: 'gemini-2.5-flash' }, []);
    const i = (out.geminiArgs ?? []).indexOf('-m');
    expect(i).toBeGreaterThanOrEqual(0);
    expect((out.geminiArgs ?? [])[i + 1]).toBe('gemini-2.5-flash');
  });

  it('Gemini CLI: env GEMINI_MODEL beats settings.model', () => {
    process.env.GEMINI_MODEL = 'gemini-2.5-pro';
    const out = builder.build('Gemini CLI', 'hi', { model: 'gemini-2.5-flash' }, []);
    const i = (out.geminiArgs ?? []).indexOf('-m');
    expect((out.geminiArgs ?? [])[i + 1]).toBe('gemini-2.5-pro');
  });

  it('Gemini CLI: omits -m entirely when neither set', () => {
    delete process.env.GEMINI_MODEL;
    const out = builder.build('Gemini CLI', 'hi', {}, []);
    expect((out.geminiArgs ?? []).includes('-m')).toBe(false);
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
    expect(out.args).toContain('--auto-approve');
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
    expect((out.match(/^mcp_servers\s*=/gm) || []).length).toBe(1);
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
    expect((out.match(/^mcp_servers\s*=/gm) || []).length).toBe(1);
    expect(out).toContain('name = "octipus"');
  });
});
