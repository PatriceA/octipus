import { describe, expect, test } from 'vitest';
import { findSlashCommand, OCTIPUS_SLASH_COMMANDS } from './slash-commands';

describe('OCTIPUS_SLASH_COMMANDS', () => {
  test('exposes both TUI-local and gateway commands', () => {
    const sources = new Set(OCTIPUS_SLASH_COMMANDS.map((c) => c.source));
    expect(sources.has('tui')).toBe(true);
    expect(sources.has('gateway')).toBe(true);
  });

  test('every entry has unique name', () => {
    const names = OCTIPUS_SLASH_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('every entry has a description (used by the autocomplete UI)', () => {
    for (const cmd of OCTIPUS_SLASH_COMMANDS) {
      expect(typeof cmd.description).toBe('string');
      expect((cmd.description ?? '').length).toBeGreaterThan(0);
    }
  });

  test('argument hints only set on commands that accept arguments', () => {
    const withHints = OCTIPUS_SLASH_COMMANDS.filter((c) => c.argumentHint !== undefined);
    const expected = new Set(['project', 'expert', 'plan', 'compact', 'changes', 'proposals', 'mcp']);
    for (const cmd of withHints) {
      expect(expected.has(cmd.name)).toBe(true);
    }
  });
});

describe('findSlashCommand', () => {
  test('resolves by primary name', () => {
    expect(findSlashCommand('help')?.name).toBe('help');
    expect(findSlashCommand('clear')?.name).toBe('clear');
  });

  test('resolves aliases to their primary command', () => {
    expect(findSlashCommand('h')?.name).toBe('help');
    expect(findSlashCommand('?')?.name).toBe('help');
    expect(findSlashCommand('cls')?.name).toBe('clear');
    expect(findSlashCommand('reload-extensions')?.name).toBe('reload');
    expect(findSlashCommand('e')?.name).toBe('expert');
  });

  test('case-insensitive lookup', () => {
    expect(findSlashCommand('HELP')?.name).toBe('help');
    expect(findSlashCommand('Quit')?.name).toBe('quit');
  });

  test('returns undefined for unknown commands', () => {
    expect(findSlashCommand('not-a-real-command')).toBeUndefined();
  });
});
