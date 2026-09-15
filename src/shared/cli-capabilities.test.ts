import { describe, expect, it } from 'vitest';
import { CLI_TOOLS } from '@/models/providers/cli-provider';
import { canResume, CLI_RESUME } from './cli-capabilities';

describe('CLI resume capability', () => {
  it('lets Claude mint its own session id', () => {
    expect(CLI_RESUME['Claude Code']).toEqual({ style: 'caller-minted', flag: '--resume' });
  });

  it('captures the id for Codex CLI', () => {
    expect(CLI_RESUME['Codex CLI'].style).toBe('captured');
  });

  it('refuses Antigravity — 1.1.5 emits no id and silently forks on a stale one', () => {
    expect(canResume('Antigravity')).toBe(false);
  });

  it('refuses Mistral Vibe', () => {
    expect(canResume('Mistral Vibe')).toBe(false);
  });

  it('allows GLM and Kimi rows — they adapt to Claude Code, so they inherit its resume capability (the run fingerprint, not this map, is what stops one resuming the other)', () => {
    const glm = CLI_TOOLS.find(t => t.name === 'Claude Code (z.ai GLM)');
    const kimi = CLI_TOOLS.find(t => t.name === 'Claude Code (Moonshot Kimi)');
    expect(glm?.adapter).toBe('Claude Code');
    expect(kimi?.adapter).toBe('Claude Code');
    expect(canResume(glm!.adapter ?? glm!.name)).toBe(true);
    expect(canResume(kimi!.adapter ?? kimi!.name)).toBe(true);
  });

  it('every CLI_RESUME key is a real adapter key derived from CLI_TOOLS, so a rename cannot silently disable resume', () => {
    const realAdapterKeys = new Set(CLI_TOOLS.map(tool => tool.adapter ?? tool.name));
    for (const key of Object.keys(CLI_RESUME)) {
      expect(realAdapterKeys.has(key)).toBe(true);
    }
  });
});
