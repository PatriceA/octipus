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
    expect(strip(line)).toBe(' ● a.ts │ b.ts ');
    expect(line).toMatch(/\x1b\[48;2;[0-9;]+m(\x1b\[[0-9;]*m)* b\.ts/); // b.ts is active
  });

  test('empty state and truncation to the width', () => {
    const buffers = new BufferStore();
    expect(strip(new TabStrip(buffers).render(40)[0])).toContain('no buffers');
    for (let i = 0; i < 20; i++) buffers.openFile(`/p/file-${i}.ts`, '');
    expect(visibleWidth(new TabStrip(buffers).render(40)[0])).toBeLessThanOrEqual(40);
  });
});
