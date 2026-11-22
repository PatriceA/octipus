import { expect, test, vi } from 'vitest';
import { Markdown } from '@/tui-kit';
import { MessagesPane, stripTranscriptRails } from './messages-pane';
import { createTranscriptView } from './transcript-view';

const strip = (lines: readonly string[]) => lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));
const push = (pane: MessagesPane, n: number, role: 'user' | 'assistant' | 'system' = 'system') => pane.push({ role, content: `message ${n}`, timestamp: new Date() });

/** Lay the view out the way the alternate screen does: render the document, then tell the view its size. */
function layout(view: ReturnType<typeof createTranscriptView>, width: number, height: number): string[] {
  const lines = view.document.render(width);
  view.updateLayout(lines.length, height, () => {});
  return strip(lines.slice(view.scrollTop, view.scrollTop + height));
}

test('only the newest window is rendered; history beyond it is announced at the top', () => {
  const pane = new MessagesPane({ windowSize: 10 });
  const render = vi.spyOn(Markdown.prototype, 'render');
  try {
    for (let n = 0; n < 1000; n++) pane.push({ role: 'assistant', content: `**answer ${n}**`, timestamp: new Date() });
    const lines = strip(pane.documentLines(80));
    // The window follows the end while the latest is shown: at most two windows rendered.
    expect(render.mock.calls.length).toBeLessThanOrEqual(20);
    expect(lines[0]).toMatch(/^· ↑ 9[89]\d earlier messages above/);
    expect(lines.join('\n')).toContain('answer 999');
    expect(lines.join('\n')).not.toContain('answer 979\n');
  } finally { render.mockRestore(); }
});

test('scrolling to the top of the window brings older items in without moving what is on screen', () => {
  const pane = new MessagesPane({ windowSize: 10 });
  for (let n = 0; n < 100; n++) push(pane, n);
  const view = createTranscriptView(pane);
  layout(view, 60, 8);
  expect(view.isFollowingEnd).toBe(true);
  view.scrollTo(2);
  const before = strip(pane.documentLines(60).slice(2, 10));
  expect(pane.size().rendered).toBe(10);
  const after = layout(view, 60, 8); // near the top of the window: older items come in above
  expect(pane.size().rendered).toBe(20);
  expect(after).toEqual(before);
  // Each time the reader reaches the top, another window comes in, until there is no more.
  for (let n = 0; n < 20; n++) { view.scrollToStart(); layout(view, 60, 8); }
  view.scrollToStart();
  expect(pane.canGrow()).toBe(false);
  expect(layout(view, 60, 8).join('\n')).toContain('message 0');
  // Back at the end, the window shrinks to the latest again.
  view.scrollToEnd();
  layout(view, 60, 8);
  expect(pane.size().rendered).toBe(10);
});

test('streamed text appended while reading history does not move the reading position', () => {
  const pane = new MessagesPane();
  for (let n = 0; n < 50; n++) push(pane, n);
  const view = createTranscriptView(pane);
  layout(view, 60, 8);
  view.scrollBy(-20);
  const before = layout(view, 60, 8);
  pane.setLive('streaming reply');
  push(pane, 99);
  expect(layout(view, 60, 8)).toEqual(before);
});

test('beyond the memory cap the oldest items go, with a notice that says so', () => {
  const pane = new MessagesPane({ maxItems: 50, windowSize: 100 });
  for (let n = 0; n < 80; n++) push(pane, n);
  expect(pane.size()).toEqual({ kept: 50, dropped: 30, rendered: 50 });
  const lines = strip(pane.documentLines(200));
  expect(lines[0]).toContain('30 earlier messages are no longer kept here (limit 50)');
  expect(lines.join('\n')).not.toContain('message 29\n');
  expect(pane.getCopyText('transcript')).not.toContain('message 29\n');
  expect(pane.entries()).toHaveLength(50);
});

test('a copied drag selection leaves out the rail in front of each row', () => {
  expect(stripTranscriptRails('│ asked this\n│ over two rows\n  the reply\n· a notice\n! Error · bad')).toBe('asked this\nover two rows\nthe reply\na notice\nError · bad');
  expect(stripTranscriptRails('      indented code')).toBe('    indented code');
});
