/** Streaming a long reply stays linear: the live block is redrawn on a budget, and the finished reply takes the rows the last frame did. */
import { afterEach, expect, test, vi } from 'vitest';
import { Markdown, type TUI } from '@/tui-kit';
import { ChatSessionPresenter, liveRedrawInterval, SEEN_MESSAGE_IDS_KEPT } from './chat-session-presenter';
import { ActivityLine } from './components/activity-line';
import { MessagesPane } from './components/messages-pane';
import { StatusBar } from './components/status-bar';
import { SubagentPanel } from './components/subagent-panel';
import type { GatewayAdapter } from './gateway-adapter';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function mount() {
  const tui = { requestRender: vi.fn() } as unknown as TUI;
  const messages = new MessagesPane({ maxVisible: 40 });
  const adapter = { sendCommand: vi.fn(() => true) } as unknown as GatewayAdapter;
  const presenter = new ChatSessionPresenter(tui, adapter, messages, new StatusBar(), new ActivityLine(tui), new SubagentPanel(),
    (role, text) => messages.push({ role, content: text, timestamp: new Date() }));
  return { presenter, messages };
}

/** One delta of a long Markdown reply, as a model streams it. */
const chunk = (n: number) => n % 12 === 11 ? `\n\n## Part ${n}\n\n` : n % 5 === 4 ? `- item **${n}** with \`code\`\n` : `Sentence ${n} of the reply, with some words in it. `;

test('a 150 KB reply in 2,000 deltas renders its Markdown a bounded number of times, not once per delta', () => {
  vi.useFakeTimers();
  const { presenter, messages } = mount();
  const renders = vi.spyOn(Markdown.prototype, 'render');
  let reply = '';
  for (let n = 0; n < 2000; n++) {
    const delta = chunk(n).padEnd(75, '.');
    reply += delta;
    presenter.handleEvent({ kind: 'delta', delta, iteration: 1 });
    // What the terminal does: a frame at most every 16 ms.
    messages.documentLines(100);
    vi.advanceTimersByTime(16);
  }
  expect(reply.length).toBeGreaterThan(145_000);
  // Once per delta before; now the redraw interval grows with the reply.
  expect(renders.mock.calls.length).toBeLessThan(500);
  // The last delta is drawn once its interval is over.
  vi.runOnlyPendingTimers();
  const streamed = messages.documentLines(100);
  expect(streamed.join('\n')).toContain('Sentence 1998');
  // The finished reply takes exactly the rows the last streamed frame did.
  presenter.handleEvent({ kind: 'message', role: 'assistant', content: reply });
  expect(messages.documentLines(100)).toEqual(streamed);
  presenter.dispose();
});

test('a short reply is drawn on every delta', () => {
  const { presenter, messages } = mount();
  presenter.handleEvent({ kind: 'delta', delta: 'Let me ', iteration: 1 });
  presenter.handleEvent({ kind: 'delta', delta: 'check.', iteration: 1 });
  expect(messages.documentLines(80).join('\n')).toContain('Let me check.');
  expect(liveRedrawInterval(100)).toBe(0);
  expect(liveRedrawInterval(150_000)).toBeGreaterThan(0);
  expect(liveRedrawInterval(10_000_000)).toBe(250);
  presenter.dispose();
});

test('the ids kept to drop repeated progress messages are capped, and a recent repeat is still dropped', () => {
  const { presenter, messages } = mount();
  for (let n = 0; n < SEEN_MESSAGE_IDS_KEPT * 5; n++) {
    presenter.handleEvent({ kind: 'message', role: 'assistant', content: `progress ${n}`, messageId: `m${n}`, progress: true });
  }
  const seen = (presenter as unknown as { seenMessageIds: Set<string> }).seenMessageIds;
  expect(seen.size).toBe(SEEN_MESSAGE_IDS_KEPT);
  const before = messages.size().kept;
  presenter.handleEvent({ kind: 'message', role: 'assistant', content: 'progress again', messageId: `m${SEEN_MESSAGE_IDS_KEPT * 5 - 1}`, progress: true });
  expect(messages.size().kept).toBe(before);
  presenter.dispose();
});
