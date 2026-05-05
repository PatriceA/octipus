import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installOctipusKeybindings, listAllKeybindings, loadOctipusKeybindings, OCTIPUS_APP_KEYBINDINGS } from './keybindings';

function tmpFile(content: string): string {
  const path = join(tmpdir(), `octipus-keybindings-${Date.now()}-${Math.random()}.json`);
  writeFileSync(path, content, 'utf8');
  return path;
}

describe('OCTIPUS_APP_KEYBINDINGS', () => {
  test('every entry has a default key + description', () => {
    for (const [id, def] of Object.entries(OCTIPUS_APP_KEYBINDINGS)) {
      expect(typeof def.description).toBe('string');
      expect(def.defaultKeys).toBeDefined();
      // Sanity: id is namespaced under 'app.'
      expect(id.startsWith('app.')).toBe(true);
    }
  });
});

describe('loadOctipusKeybindings', () => {
  test('returns empty for missing file', () => {
    expect(loadOctipusKeybindings('/nope/never/exists.json')).toEqual({});
  });

  test('returns empty for malformed JSON', () => {
    const path = tmpFile('{ not json');
    expect(loadOctipusKeybindings(path)).toEqual({});
  });

  test('parses a flat user override map', () => {
    const path = tmpFile(JSON.stringify({ 'app.tree.toggle': 'ctrl+t' }));
    expect(loadOctipusKeybindings(path)).toEqual({ 'app.tree.toggle': 'ctrl+t' });
  });
});

describe('installOctipusKeybindings', () => {
  test('returns a manager that resolves defaults', () => {
    const manager = installOctipusKeybindings({});
    expect(manager.getKeys('app.palette.open')).toContain('ctrl+p');
    expect(manager.matches('\x10', 'app.palette.open')).toBe(true);
  });

  test('user override replaces default keys', () => {
    const manager = installOctipusKeybindings({ 'app.tree.toggle': 'ctrl+t' });
    expect(manager.getKeys('app.tree.toggle')).toEqual(['ctrl+t']);
    expect(manager.matches('\x14', 'app.tree.toggle')).toBe(true);
  });
});

describe('listAllKeybindings', () => {
  test('includes both pi-tui and octipus bindings, sorted', () => {
    const manager = installOctipusKeybindings({});
    const all = listAllKeybindings(manager);
    const ids = all.map((b) => b.id);
    expect(ids).toContain('app.palette.open');
    expect(ids).toContain('tui.editor.cursorUp');
    // Sorted check
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});
