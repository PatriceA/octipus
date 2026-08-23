import { afterEach, describe, expect, it } from 'vitest';
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
