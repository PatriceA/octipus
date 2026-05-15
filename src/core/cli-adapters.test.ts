import { afterEach, describe, expect, it } from 'bun:test';
import { CLIArgumentBuilder } from './cli-adapters';

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
