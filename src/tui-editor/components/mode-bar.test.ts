import { describe, expect, test } from 'vitest';
import { BufferStore } from '../stores/buffer-store';
import { LayoutStore } from '../stores/layout-store';
import type { VimMode } from '../editor/vim';
import { ModeBar } from './mode-bar';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('ModeBar', () => {
  function bar(vim: VimMode = 'NORMAL', commandLine: string | null = null) {
    const layout = new LayoutStore();
    const buffers = new BufferStore();
    const modeBar = new ModeBar(layout, buffers, { getVimMode: () => vim, getVimCommandLine: () => commandLine });
    return { layout, buffers, modeBar, text: () => strip(modeBar.render(120)[0]) };
  }

  test('mode, focus, buffer, language, cursor, dirty and lock', () => {
    const { buffers, text } = bar();
    const rec = buffers.openFile('/p/x.ts', 'hello');
    rec.buffer.moveLineEnd();
    rec.buffer.type('!');
    buffers.setAgentLocked(rec.id, true);
    expect(text()).toBe('EDIT  focus:editor  L1:7  x.ts ●  typescript  agent-lock');
  });

  test('what waits for the resolve key is shown after the cursor position, which a narrow bar keeps', () => {
    const layout = new LayoutStore();
    const buffers = new BufferStore();
    buffers.openFile('/p/x.ts', 'hello');
    const modeBar = new ModeBar(layout, buffers, { getAttention: () => 'agent edit to a-very-long-file-name.ts ready for review — press alt+y to resolve' });
    const row = strip(modeBar.render(60)[0]);
    expect(row).toMatch(/^EDIT  focus:editor  L1:1  ⚑ agent edit to a-very-long/);
  });

  test('vim mode shows its sub-mode, and the : command while it is typed', () => {
    const ctx = bar('VISUAL');
    ctx.layout.setEditorMode('vim');
    expect(ctx.text()).toMatch(/^VIM VISUAL/);
    const typing = bar('NORMAL', 'wq');
    typing.layout.setEditorMode('vim');
    expect(typing.text()).toBe(':wq ');
  });

  test('an info notice lasts until cleared; an error notice and a failed checkpoint stay', () => {
    const { modeBar, text } = bar();
    modeBar.setNotice('Saved a.ts.', 'info');
    expect(text()).toBe('Saved a.ts.');
    expect(modeBar.clearInfo()).toBe(true);
    expect(text()).toMatch(/^EDIT/);
    modeBar.setNotice('Save failed');
    expect(modeBar.clearInfo()).toBe(false);
    expect(text()).toBe('Save failed');
    expect(modeBar.setRecoveryFailed(true)).toBe(true);
    expect(text()).toContain('Recovery checkpoint failed');
  });
});
