import { describe, expect, test } from 'vitest';
import { installEditorKeybindings } from '../keybindings';
import { HotkeysOverlay } from './hotkeys-overlay';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07/g, '');

describe('HotkeysOverlay', () => {
  test('lists the editor bindings, Save As and the vim toggle included, with the vim commands', () => {
    installEditorKeybindings({});
    const overlay = new HotkeysOverlay({ onClose: () => {} });
    overlay.setMaxRows(200);
    const text = overlay.render(100).map(strip).join('\n');
    expect(text).toMatch(/f12 .*Save As/);
    expect(text).toMatch(/alt\+m .*vim mode/);
    expect(text).toContain(':wq');
  });

  test('fits the rows it is given and scrolls inside them', () => {
    installEditorKeybindings({});
    const overlay = new HotkeysOverlay({ onClose: () => {} });
    overlay.setMaxRows(12);
    const first = overlay.render(100).map(strip);
    expect(first).toHaveLength(12);
    expect(first.at(-1)?.startsWith('└')).toBe(true);
    overlay.handleInput('\x1b[6~');
    expect(overlay.render(100).map(strip)[1]).not.toBe(first[1]);
  });

  test('Esc, q and Enter close', () => {
    let closed = 0;
    const overlay = new HotkeysOverlay({ onClose: () => { closed++; } });
    for (const key of ['\x1b', 'q', '\r']) overlay.handleInput(key);
    expect(closed).toBe(3);
  });
});
