import { expect, test, vi } from 'vitest';
import { type TUI, visibleWidth } from '@/tui-kit';
import { ChatPane } from './chat-pane';

const tui = { requestRender: vi.fn(), terminal: { rows: 24, columns: 80 } } as unknown as TUI;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07/g, '');

test('fills exactly the rows it is given: transcript on top, composer at the bottom', () => {
  const pane = new ChatPane({ tui, basePath: '/tmp', onSubmit: () => {} });
  pane.messages.push({ role: 'user', content: 'first question', timestamp: new Date() });
  pane.setHeight(12);
  const lines = pane.render(40);
  expect(lines).toHaveLength(12);
  expect(lines.map(strip).join('\n')).toContain('first question');
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
});

test('a submitted message reaches the app', () => {
  const submitted: string[] = [];
  const pane = new ChatPane({ tui, basePath: '/tmp', onSubmit: (text) => submitted.push(text) });
  pane.composer.focused = true;
  for (const c of 'hi') pane.composer.handleInput(c);
  pane.composer.handleInput('\r');
  expect(submitted).toEqual(['hi']);
});

test('a long transcript keeps the latest rows and the composer in view', () => {
  const pane = new ChatPane({ tui, basePath: '/tmp', onSubmit: () => {} });
  for (let i = 0; i < 40; i++) pane.messages.push({ role: 'assistant', content: `answer ${i}`, timestamp: new Date() });
  pane.setHeight(10);
  const text = pane.render(40).map(strip).join('\n');
  expect(text).toContain('answer 39');
  expect(text).not.toContain('answer 0\n');
});
