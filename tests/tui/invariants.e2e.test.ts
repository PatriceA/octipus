/**
 * Invariants of the chat frame under random gateway traffic and resizes.
 *
 * Each seed drives the real entry point through a random sequence of events —
 * streamed and final replies, tool calls and results, subagents, narration,
 * decisions — whose text mixes control bytes, escape sequences, wide
 * characters, emoji sequences, combining marks and 10 kB single lines, with
 * random resizes in between. After every step the screen must still hold:
 *
 *   - the status line on the last row, exactly once;
 *   - the composer (the draft typed at the start) above it, with the cursor
 *     on its row — unless a decision box is open and has the focus;
 *   - no row wider than the terminal (no row the terminal had to wrap);
 *   - the cursor inside the screen.
 *
 *   TUI_FUZZ_SEEDS=500 npm run test:tui -- tests/tui/invariants   # more seeds
 *   TUI_FUZZ_SEED=17 npx vitest run tests/tui/invariants          # one seed
 *
 * A failure names the seed, the step and the action, and prints the screen.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { TuiHarness } from './harness';

const SEEDS = process.env.TUI_FUZZ_SEED
  ? [Number(process.env.TUI_FUZZ_SEED)]
  : Array.from({ length: Number(process.env.TUI_FUZZ_SEEDS ?? 8) }, (_, n) => n + 1);
const STEPS = Number(process.env.TUI_FUZZ_STEPS ?? 30);
const STATUS = '● Octipus';
const DRAFT = 'draft-under-test';

let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

/** mulberry32: small, seedable, good enough to pick test inputs. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Spacing marks of Devanagari-like scripts are a known width disagreement
// (src/tui-pi/terminal-text.width.test.ts) and are left out on purpose.
const FRAGMENTS = [
  'plain words', 'x', 'path/to/file.ts:42', '世界', '한국어', 'Ａｂ', '🐙', '✅', '⚠\ufe0f', '👨\u200d👩\u200d👧', '👍\u{1f3fd}', '🇫🇷', '🏳\ufe0f\u200d🌈',
  'e\u0301', 'a\u0301\u0302', 'กำ', '± ① ─ ● …', 'α ж', '\u200b', '\u00ad', '\u202e', '\ufe0f',
  '\t', '\r', '\r\n', '\n', '\n\n', '\x00', '\x07', '\x08', '\x0b', '\x0c', '\x1b', '\x7f', '\x85', '\x9b',
  '\x1b[2J', '\x1b[H', '\x1b[10A', '\x1b[31mred\x1b[0m', '\x1b]0;title\x07', '\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\', '\x1bP1$r\x1b\\',
  '**bold**', '`code`', '# heading', '- item', '```\nfenced\n```', '| a | b |\n|---|---|\n| 1 | 2 |',
];

function textFrom(rand: () => number): string {
  const roll = rand();
  if (roll < 0.06) return pick(rand, FRAGMENTS).repeat(Math.ceil(10_240 / 8)).slice(0, 10_240) + 'END';
  if (roll < 0.1) return Array.from({ length: 20 + Math.floor(rand() * 60) }, (_, n) => `line ${n} ${pick(rand, FRAGMENTS)}`).join('\n');
  return Array.from({ length: 1 + Math.floor(rand() * 8) }, () => pick(rand, FRAGMENTS)).join(rand() < 0.5 ? ' ' : '');
}
function pick<T>(rand: () => number, items: readonly T[]): T { return items[Math.floor(rand() * items.length)] as T; }

type Step = { label: string; run: (h: TuiHarness) => void; decision?: boolean; answer?: boolean };

function stepFrom(rand: () => number, pending: number, agents: string[]): Step {
  const roll = rand();
  const text = () => textFrom(rand);
  if (pending > 0 && roll < 0.25) return { label: 'answer decision (Esc)', run: h => h.send('\x1b'), answer: true };
  if (roll < 0.12) {
    const cols = 30 + Math.floor(rand() * 131); const rows = 8 + Math.floor(rand() * 43);
    return { label: `resize ${cols}x${rows}`, run: h => h.resize(cols, rows) };
  }
  if (roll < 0.24) { const t = text(); return { label: 'chat.delta', run: h => h.event('chat.delta', { delta: t, iteration: 1 }) }; }
  if (roll < 0.32) { const t = text(); return { label: 'chat.response', run: h => h.event('chat.response', { response: t }) }; }
  if (roll < 0.44) {
    const t = text(); const tool = pick(rand, ['shell', 'read_file', text().slice(0, 40)]);
    return { label: 'tool_call', run: h => h.event('agent.action', { agentId: pick(rand, ['root', ...agents]), data: { type: 'tool_call', toolName: tool, args: { command: t } } }) };
  }
  if (roll < 0.52) { const t = text(); return { label: 'tool_result', run: h => h.event('agent.action', { agentId: 'root', data: { type: 'tool_result', toolName: 'shell', output: t } }) }; }
  if (roll < 0.57) {
    const role = text().slice(0, 60); const title = text().slice(0, 60);
    return { label: 'tool_call_complete', run: h => h.event('agent.action', { data: { type: 'tool_call_complete', name: 'read', title, role, status: rand() < 0.3 ? 'error' : 'ok', error: text(), durationMs: 120 } }) };
  }
  if (roll < 0.65) {
    const id = `node-${agents.length}`; agents.push(id); const role = text().slice(0, 50);
    return { label: 'subagent spawned', run: h => h.event('swarm.node_spawned', { nodeId: id, role, model: 'test-model', topicPath: text().slice(0, 30) }) };
  }
  if (roll < 0.69 && agents.length) {
    const id = pick(rand, agents);
    return { label: 'subagent completed', run: h => h.event('swarm.node_completed', { nodeId: id, role: 'worker', usedTokens: 1200, durationMs: 3400 }) };
  }
  if (roll < 0.73) return { label: 'root agent spawned', run: h => h.event('agent.spawned', { agentId: 'root', role: 'general', model: text().slice(0, 40) }) };
  if (roll < 0.76) return { label: 'root agent completed', run: h => h.event('agent.completed', { agentId: 'root', role: 'general', stats: { totalTokens: 900, durationMs: 1500, iterations: 2 } }) };
  if (roll < 0.8) { const t = text(); return { label: 'narration', run: h => h.event('swarm.narration', { text: t }) }; }
  if (roll < 0.83) { const t = text(); return { label: 'blocked', run: h => h.event('agent.blocked', { reason: t, blockedForMs: 20_000 }) }; }
  if (roll < 0.86) return { label: 'session.stats', run: h => h.event('session.stats', { totalTokens: Math.floor(rand() * 2e6), totalCostUsd: rand() * 9, requestCount: 3, contextTokens: 5000, contextWindow: 8000 }) };
  if (roll < 0.94) {
    const question = text(); const options = rand() < 0.5 ? [] : Array.from({ length: 1 + Math.floor(rand() * 4) }, () => text().slice(0, 200));
    return { label: 'approval', decision: true, run: h => h.event('agent.approval_required', { requestId: `q${rand()}`, summary: text(), question, options }) };
  }
  const command = text();
  return { label: 'permission', decision: true, run: h => h.event('permission.request', { requestId: `p${rand()}`, toolName: 'shell', args: { command } }) };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 70));

async function violations(h: TuiHarness, decisionOpen: boolean): Promise<string[]> {
  const rows = (await h.text()).split('\n');
  const found: string[] = [];
  const statusRows = rows.flatMap((row, index) => row.includes(STATUS) ? [index] : []);
  if (statusRows.length !== 1 || statusRows[0] !== rows.length - 1) found.push(`status line at rows [${statusRows.join(', ')}] of ${rows.length}`);
  const buffer = h.screen.buffer.active;
  if (!decisionOpen) {
    const draft = rows.findIndex(row => row.includes(DRAFT));
    if (draft < 0 || draft >= rows.length - 1) found.push(`composer draft at row ${draft}`);
    else if (buffer.cursorY !== draft) found.push(`cursor at row ${buffer.cursorY}, composer at row ${draft}`);
  }
  for (let row = 0; row < h.screen.rows; row++) {
    if (buffer.getLine(buffer.viewportY + row)?.isWrapped) found.push(`row ${row - 1} was wider than ${h.screen.cols} columns and wrapped`);
  }
  if (buffer.cursorY < 0 || buffer.cursorY >= h.screen.rows) found.push(`cursor at row ${buffer.cursorY} of ${h.screen.rows}`);
  return found;
}

describe.skipIf(process.platform === 'win32')('chat frame invariants under random events and resizes', () => {
  test.each(SEEDS)('seed %i', async seed => {
    const rand = random(seed);
    const cols = 40 + Math.floor(rand() * 120); const rows = 12 + Math.floor(rand() * 38);
    tui = await TuiHarness.start('src/tui-pi/index.ts', cols, rows);
    await tui.waitFor('connected');
    tui.send(DRAFT); await tui.waitFor(DRAFT);
    const log = [`start ${cols}x${rows}`];
    let pending = 0;
    const agents: string[] = [];
    for (let n = 0; n < STEPS; n++) {
      const step = stepFrom(rand, pending, agents);
      log.push(step.label);
      step.run(tui);
      if (step.decision) pending++;
      if (step.answer) pending--;
      await settle();
      const broken = await violations(tui, pending > 0);
      if (broken.length) {
        expect.fail(`seed ${seed}, step ${n + 1} (${step.label}): ${broken.join('; ')}\nsteps: ${log.join(' → ')}\nrerun: TUI_FUZZ_SEED=${seed} npx vitest run tests/tui/invariants.e2e.test.ts\n${await tui.text()}`);
      }
    }
  });
});
