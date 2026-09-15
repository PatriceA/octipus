import { describe, expect, it } from 'vitest';
import { canResume, CLI_RESUME } from './cli-capabilities';

describe('CLI resume capability', () => {
  it('lets Claude mint its own session id', () => {
    expect(CLI_RESUME['Claude Code']).toEqual({ style: 'caller-minted', flag: '--resume' });
  });

  it('captures the id for Codex', () => {
    expect(CLI_RESUME.Codex.style).toBe('captured');
  });

  it('refuses Antigravity — 1.1.5 emits no id and silently forks on a stale one', () => {
    expect(canResume('Antigravity')).toBe(false);
  });

  it('refuses Vibe', () => {
    expect(canResume('Vibe')).toBe(false);
  });
});
