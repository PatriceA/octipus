import { describe, expect, test } from 'vitest';
import { visibleWidth } from '@/tui-kit';
import { BufferStore } from '../stores/buffer-store';
import { TabStrip } from './tab-strip';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('TabStrip', () => {
  test('one tab per buffer, the dirty ones marked, the active one inverted', () => {
    const buffers = new BufferStore();
    const a = buffers.openFile('/p/a.ts', 'a');
    buffers.openFile('/p/b.ts', 'b');
    a.buffer.insert('!');
    const [line] = new TabStrip(buffers).render(80);
    expect(strip(line)).toBe(' ● a.ts × │ b.ts × ');
    expect(line).toMatch(/\x1b\[48;2;[0-9;]+m(\x1b\[[0-9;]*m)* b\.ts/); // b.ts is active
  });

  test('empty state and truncation to the width', () => {
    const buffers = new BufferStore();
    expect(strip(new TabStrip(buffers).render(40)[0])).toContain('no buffers');
    for (let i = 0; i < 20; i++) buffers.openFile(`/p/file-${i}.ts`, '');
    expect(visibleWidth(new TabStrip(buffers).render(40)[0])).toBeLessThanOrEqual(40);
  });

  test('a click on a tab activates it, a click on its × closes it (docs/plans/tui-modernization.md §7, Phase 5)', () => {
    const buffers = new BufferStore();
    const a = buffers.openFile('/p/a.ts', 'a');
    const b = buffers.openFile('/p/b.ts', 'b');
    const closed: string[] = [];
    const tabs = new TabStrip(buffers, { onClose: (id) => closed.push(id) });
    const line = strip(tabs.render(80)[0]);
    const click = (x: number) => tabs.handleMouse({ type: 'click', button: 'left', x, y: 0, screenX: x, screenY: 0, width: 80, height: 1, shift: false, alt: false, ctrl: false, clickCount: 1 });
    click(line.indexOf('a.ts'));
    expect(buffers.active()?.id).toBe(a.id);
    click(line.lastIndexOf('×'));
    expect(closed).toEqual([b.id]);
    click(line.indexOf('×'));
    expect(closed).toEqual([b.id, a.id]);
  });
});
