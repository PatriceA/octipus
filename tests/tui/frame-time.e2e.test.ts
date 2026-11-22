/**
 * Plan §4.4 criterion 3: a 5,000-message transcript scrolls and streams
 * without visible lag — frame time under 16 ms at 200×60.
 *
 * The real chat app on the real alternate-screen renderer, over a terminal
 * that counts bytes instead of drawing them, so the time measured is ours and
 * pi-tui's: layout, rendering the transcript window, the row diff. It runs in
 * the single-worker terminal project, where nothing else competes for the CPU.
 *
 *   npx vitest run tests/tui/frame-time.e2e.test.ts
 */
import { afterAll, expect, test, vi } from 'vitest';
import { type Terminal, TuiAltScreen } from '../../src/tui-kit';
import { OctipusTuiApp } from '../../src/tui-pi/app';
import type { AgentSessionEvent } from '../../src/tui-pi/gateway-adapter';
import { installOctipusKeybindings } from '../../src/tui-pi/keybindings';

const gateway = vi.hoisted(() => ({ listener: (_event: AgentSessionEvent) => {} }));
vi.mock('../../src/tui-pi/gateway-adapter', () => ({ GatewayAdapter: class {
  on(listener: (event: AgentSessionEvent) => void) { gateway.listener = listener; }
  sendCommand() { return true; }
  sendChat() { return true; }
  getWorkspace() { return null; }
  isConnected() { return true; }
  disconnect() {}
} }));
vi.mock('../../src/core/gateway/cli-session', () => ({ readCliSession: () => null }));

const COLS = 200;
const ROWS = 60;
const MESSAGES = 5_000;
const BUDGET_MS = 16;

let written = 0;
const terminal: Terminal = {
  start() {}, stop() {}, async drainInput() {}, write(data: string) { written += data.length; },
  get columns() { return COLS; }, get rows() { return ROWS; }, get kittyProtocolActive() { return false; },
  moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
  setTitle() {}, setProgress() {}, setProgramStatus() {},
};

installOctipusKeybindings({});
const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
const app = new OctipusTuiApp(tui, {});
afterAll(async () => { await app.stop(); tui.stop({ preserveScreen: true }); });

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)] ?? Number.POSITIVE_INFINITY;
}
function frame(change: () => void): number {
  change();
  const start = performance.now();
  tui.renderNow();
  return performance.now() - start;
}

test(`a ${MESSAGES.toLocaleString('en-US')}-message transcript streams and scrolls in under ${BUDGET_MS} ms a frame at ${COLS}x${ROWS}`, () => {
  tui.start();
  gateway.listener({ kind: 'status', status: 'connected' });
  for (let n = 0; n < MESSAGES; n++) {
    gateway.listener(n % 2
      ? { kind: 'message', role: 'assistant', content: `Reply **${n}** with \`code\` and a list:\n- one\n- two ${'word '.repeat(30)}` }
      : { kind: 'message', role: 'user', content: `Question ${n} ${'text '.repeat(10)}` });
  }
  tui.renderNow();
  written = 0;

  let text = '';
  const streaming = Array.from({ length: 120 }, (_, n) => frame(() => {
    text += `token${n} `;
    gateway.listener({ kind: 'delta', delta: `token${n} `, iteration: 1 });
  }));
  expect(written).toBeGreaterThan(0);
  expect(text.length).toBeGreaterThan(0);

  // Up through history, past the rendered window so older messages page in, and back down.
  const up = Array.from({ length: 150 }, () => frame(() => tui.scrollBy(-ROWS)));
  // Further back than the first rendered window of 200 messages reaches.
  const oldest = Math.min(...[...tui.getScreenLines().join('\n').matchAll(/Question (\d+)/g)].map(match => Number(match[1])));
  expect(oldest).toBeLessThan(MESSAGES - 400);
  const scrolling = [...up, ...Array.from({ length: 150 }, () => frame(() => tui.scrollBy(ROWS)))];
  const shown = tui.getScreenLines().join('\n');
  expect(shown).toContain('token119');

  const report = `stream p95 ${p95(streaming).toFixed(2)} ms, scroll p95 ${p95(scrolling).toFixed(2)} ms`;
  console.log(report);
  expect(p95(streaming), report).toBeLessThan(BUDGET_MS);
  expect(p95(scrolling), report).toBeLessThan(BUDGET_MS);
});
