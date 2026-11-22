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
 *   - the cursor inside the screen;
 *   - the alternate screen still showing (every fourth seed runs `--inline`
 *     and must stay in the normal buffer), and no scrollback erase (`ESC[3J`)
 *     ever written.
 *
 * Mouse traffic is part of the mix on the alternate screen: wheel notches
 * over the transcript and the footer, and drags that select and copy.
 *
 * So are the chat's own items and areas: tool calls and results paired by
 * id into a turn's group (expanded and collapsed with Ctrl+O, clicked),
 * reasoning folded into a thinking item (a delta of a new iteration),
 * messages typed during a turn queued above the composer (the draft is put
 * back after each), the input-history and command pickers opened and
 * closed, plan updates pushed by the gateway, and on a third of the seeds a
 * terminal that shows OSC 8 links, so rows carry link sequences.
 *
 * And the turn, against a model of what the chat must do: gateway traffic in
 * the shapes the server emits (`src/tui-pi/testing/wire.ts` — workers that
 * finish while the root runs, the root finishing then its reply), error
 * frames that are not the turn failing (a stale permission answer, an
 * expired approval, a rate limit, dropped events, another tab's stop) and
 * ones that are (CHAT_ERROR for this turn's send), and the connection dropped
 * and restored with a message typed while it was down. After every step the
 * messages the chat sent must be the model's, in its order, and the window
 * title must say whether a turn runs; at the end every message typed has
 * been sent exactly once, in the order it was typed.
 *
 *   TUI_FUZZ_SEEDS=500 npm run test:tui -- tests/tui/invariants   # more seeds
 *   TUI_FUZZ_SEED=17 npx vitest run tests/tui/invariants          # one seed
 *
 * A failure names the seed, the step and the action, and prints the screen.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { errorFrame, wire } from '../../src/tui-pi/testing/wire';
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
// (src/tui-kit/terminal-text.width.test.ts) and are left out on purpose.
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

type Step = {
  label: string;
  run: (h: TuiHarness) => void | Promise<void>;
  decision?: boolean; answer?: boolean; picker?: 'open' | 'close';
  /** What the step does to the model of the turn and the queue (after it ran). */
  model?: (m: TurnModel) => void;
};

/**
 * What the chat must be doing: whether a turn runs (the latest message sent,
 * or one another tab started), what waits in its queue, what it sent.
 */
class TurnModel {
  turn: 'none' | 'latest' | 'foreign' = 'none';
  connected = true;
  readonly queue: string[] = [];
  readonly sent: string[] = [];
  readonly typed: string[] = [];
  submit(tag: string): void {
    this.typed.push(tag);
    if (this.turn !== 'none' || !this.connected) this.queue.push(tag);
    else this.send(tag);
  }
  /** The running turn's answer arrived: it ends, and the next queued message goes out. */
  answer(): void {
    if (this.turn === 'none') return;
    this.turn = 'none';
    this.next();
  }
  rootStarted(): void { if (this.turn === 'none') this.turn = 'foreign'; }
  dropped(): void { this.turn = 'none'; this.connected = false; }
  reconnected(): void { this.connected = true; this.next(); }
  private next(): void {
    const tag = this.connected && this.turn === 'none' ? this.queue.shift() : undefined;
    if (tag) this.send(tag);
  }
  private send(tag: string): void { this.sent.push(tag); this.turn = 'latest'; }
}

/** The chat's reply to the running turn, as the server sends it: echoing its turnId, or none for a turn another tab started. */
function answerPayload(h: TuiHarness, m: TurnModel, response: string): Record<string, unknown> {
  return m.turn === 'latest' ? { response, turnId: h.latestTurnId() } : { response, turnId: undefined };
}

/** Error frames and events that are not the turn failing: the turn and the queue must not move. */
const UNRELATED: Array<{ label: string; run: (h: TuiHarness) => void }> = [
  { label: 'PERMISSION_ERROR frame', run: h => h.frame(errorFrame('PERMISSION_ERROR', 'That permission request is no longer pending (already answered, or expired).')) },
  { label: 'APPROVAL_EXPIRED frame', run: h => h.frame(errorFrame('APPROVAL_EXPIRED', 'The approval expired')) },
  { label: 'RATE_LIMITED frame (a command)', run: h => h.frame(errorFrame('RATE_LIMITED', 'Rate limited. Retry after 2s')) },
  { label: 'events_dropped', run: h => h.frame({ type: 'events_dropped', count: 3, reason: 'slow consumer' }) },
  { label: 'another session\'s root stopped', run: h => { const e = wire.agentStopped('99999999-0000-4000-8000-000000000000', 'root-x', true); h.event(e.type, e.payload, e.sessionId); } },
  { label: 'a late CHAT_CANCELLED of an old turn', run: h => h.frame(errorFrame('CHAT_CANCELLED', 'Task was stopped', { turnId: 'turn-long-gone' })) },
];
let tags = 0;

let calls = 0;

/** The chat's own items and areas; null when the roll is not one of them. */
function chatStep(rand: () => number, pending: number, m: TurnModel, rows: number): Step | null {
  const roll = rand();
  const text = () => textFrom(rand);
  if (roll < 0.08) {
    const id = `call-${++calls}`; const tool = pick(rand, ['shell', 'str_replace_editor', text().slice(0, 30)]); const t = text();
    return { label: `tool call ${id}`, run: h => h.event('agent.action', { agentId: 'root', data: { type: 'cli_tool_use', id, toolName: tool, args: tool === 'str_replace_editor' ? { path: 'a.ts', old_str: t, new_str: text() } : { command: t } } }) };
  }
  if (roll < 0.14 && calls) {
    const id = `call-${1 + Math.floor(rand() * calls)}`; const t = text();
    return { label: `tool result ${id}`, run: h => h.event('agent.action', { agentId: 'root', data: { type: 'cli_tool_result', id, toolName: 'shell', output: t, isError: rand() < 0.2 } }) };
  }
  if (roll < 0.18) {
    const t = text(); const iteration = 1 + Math.floor(rand() * 4);
    return { label: `delta, iteration ${iteration}`, run: h => h.event('chat.delta', { delta: t, iteration }) };
  }
  if (roll < 0.21 && pending === 0) return { label: 'Ctrl+O', run: h => h.send('\x0f') };
  if (roll < 0.24) {
    // Never on a queued row: a click there takes the message back to edit it, which the model does not do.
    const row = 1 + Math.floor(rand() * Math.min(10, m.queue.length ? Math.max(1, Math.floor(rows / 3)) : 10));
    return { label: `click at 4,${row}`, run: h => h.send(`\x1b[<0;4;${row}M\x1b[<0;4;${row}m`) };
  }
  if (roll < 0.29 && pending === 0) {
    // Typed, so no key in it: no ESC (Esc stops the turn), no control bytes, nothing that opens completion or continues the line.
    const t = text().replace(/[\x00-\x1f\x7f-\x9f@/\\]/g, ' ').slice(0, 200);
    const tag = `m-${++tags}`;
    // Ctrl+U takes the draft away, the message is submitted (queued while a turn runs), the draft is typed again.
    return { label: `submit ${tag}, then the draft again`, run: h => { h.send('\x15'); h.send(`${tag} ${t}\r`); h.send(DRAFT); }, model: model => model.submit(tag) };
  }
  if (roll < 0.32 && pending === 0) {
    const key = pick(rand, ['\x12', '\x10']); const filter = pick(rand, ['', 'e', 'zz', '世']);
    return { label: `open ${key === '\x12' ? 'history' : 'command'} picker`, picker: 'open', run: h => { h.send(key); if (filter) h.send(filter); } };
  }
  if (roll < 0.34) return { label: 'plan updated', run: h => h.event('session.plan_updated', { revision: Math.floor(rand() * 9) }) };
  return null;
}

/** The turn and the connection, in the shapes the server really sends. */
function turnStep(rand: () => number, pending: number, m: TurnModel): Step | null {
  const roll = rand();
  if (roll < 0.2) {
    const id = `worker-${Math.floor(rand() * 4)}`;
    return rand() < 0.5
      ? { label: `worker ${id} spawned`, run: h => { const e = wire.workerSpawned('', id, 'root'); h.event(e.type, e.payload); } }
      : { label: `worker ${id} completed`, run: h => { const e = wire.workerCompleted('', id); h.event(e.type, e.payload); } };
  }
  if (roll < 0.45) { const u = pick(rand, UNRELATED); return { label: u.label, run: u.run }; }
  if (roll < 0.6 && m.turn === 'latest') {
    return { label: 'CHAT_ERROR for this turn', run: h => h.frame(errorFrame('CHAT_ERROR', 'model failed', { turnId: h.latestTurnId() })), model: model => model.answer() };
  }
  if (roll < 0.75) {
    const t = textFrom(rand);
    // The real order: the root's worker_completed, then the reply.
    return {
      label: 'root completed, then its reply',
      run: h => { const e = wire.rootCompleted('', 'root'); h.event(e.type, e.payload); h.event('chat.response', answerPayload(h, m, t)); },
      model: model => model.answer(),
    };
  }
  if (roll < 0.85 && pending === 0) {
    const tag = `m-${++tags}`;
    return {
      label: `connection dropped, ${tag} typed while down, reconnected`,
      run: async h => {
        h.dropConnections();
        await waitForStatus(h, 'disconnected');
        h.send('\x15'); h.send(`${tag} typed offline\r`); h.send(DRAFT);
        await h.waitFor(tag);
        await waitForStatus(h, 'connected');
      },
      model: model => { model.dropped(); model.submit(tag); model.reconnected(); },
    };
  }
  return null;
}

/** Wait until the status row (the last) names this connection status. */
async function waitForStatus(h: TuiHarness, status: 'connected' | 'disconnected'): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 6000) {
    const last = (await h.text()).split('\n').at(-1) ?? '';
    if (new RegExp(`(^|\\s)${status}\\b`).test(last)) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`the status row never said ${status}:\n${await h.text()}`);
}

function stepFrom(rand: () => number, pending: number, agents: string[], pickerOpen: boolean, m: TurnModel, rows: number): Step {
  if (pickerOpen) return { label: 'close picker (Esc)', picker: 'close', run: h => h.send('\x1b') };
  const chat = rand() < 0.35 ? chatStep(rand, pending, m, rows) : null;
  if (chat) return chat;
  const turn = rand() < 0.3 ? turnStep(rand, pending, m) : null;
  if (turn) return turn;
  const roll = rand();
  const text = () => textFrom(rand);
  if (pending > 0 && roll < 0.25) return { label: 'answer decision (Esc)', run: h => h.send('\x1b'), answer: true };
  if (roll < 0.05) {
    const col = 1 + Math.floor(rand() * 30); const row = 1 + Math.floor(rand() * 10); const up = rand() < 0.6;
    return { label: `wheel ${up ? 'up' : 'down'} at ${col},${row}`, run: h => h.send(`\x1b[<${up ? 64 : 65};${col};${row}M`) };
  }
  if (roll < 0.08) {
    const col = 1 + Math.floor(rand() * 20); const row = 1 + Math.floor(rand() * 6); const to = row + Math.floor(rand() * 4);
    return { label: `drag ${col},${row} → ${col + 10},${to}`, run: h => h.send(`\x1b[<0;${col};${row}M\x1b[<32;${col + 10};${to}M\x1b[<0;${col + 10};${to}m`) };
  }
  if (roll < 0.12) {
    const cols = 30 + Math.floor(rand() * 131); const rows = 8 + Math.floor(rand() * 43);
    return { label: `resize ${cols}x${rows}`, run: h => h.resize(cols, rows) };
  }
  if (roll < 0.24) { const t = text(); return { label: 'chat.delta', run: h => h.event('chat.delta', { delta: t, iteration: 1 }) }; }
  if (roll < 0.32) { const t = text(); return { label: 'chat.response', run: h => h.event('chat.response', answerPayload(h, m, t)), model: model => model.answer() }; }
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
  if (roll < 0.73) return { label: 'root agent spawned', run: h => h.event('agent.spawned', { agentId: 'root', role: 'general', root: true, model: text().slice(0, 40) }), model: model => model.rootStarted() };
  if (roll < 0.76) {
    const t = text();
    return {
      label: 'root agent completed, then its reply',
      run: h => { h.event('agent.completed', { workerId: 'root', role: 'general', root: true, result: '', totalTokens: 900, durationMs: 1500, iterations: 2 }); h.event('chat.response', answerPayload(h, m, t)); },
      model: model => model.answer(),
    };
  }
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

/** The tagged messages the chat sent, in order. */
const sentTags = (h: TuiHarness) => h.commands.filter(c => c.type === 'chat.send').map(c => /^m-\d+/.exec(String(c.content))?.[0] ?? String(c.content));
/** Whether the window title (set last) says a turn runs, waits for the user, or neither. */
function titleState(h: TuiHarness): 'working' | 'waiting' | 'idle' {
  const titles = [...h.rawOutput().matchAll(/\x1b\]0;([^\x07]*)\x07/g)];
  const last = titles.at(-1)?.[1] ?? '';
  return last.endsWith('working…') ? 'working' : last.endsWith('waiting for you') ? 'waiting' : 'idle';
}

/** Where the chat's turn and queue part from the model, if they do. */
function modelViolations(h: TuiHarness, m: TurnModel, pending: number): string[] {
  const found: string[] = [];
  const sent = sentTags(h);
  if (sent.join(' ') !== m.sent.join(' ')) found.push(`sent [${sent.join(', ')}], the model sent [${m.sent.join(', ')}]`);
  const expected = pending > 0 ? 'waiting' : m.turn === 'none' ? 'idle' : 'working';
  const title = titleState(h);
  if (title !== expected) found.push(`the title says ${title}, the model ${expected} (turn: ${m.turn}, queued: [${m.queue.join(', ')}])`);
  return found;
}

async function violations(h: TuiHarness, decisionOpen: boolean, inline: boolean): Promise<string[]> {
  const rows = (await h.text()).split('\n');
  const found: string[] = [];
  const buffer = h.screen.buffer.active;
  if (buffer.type !== (inline ? 'normal' : 'alternate')) found.push(`showing the ${buffer.type} buffer`);
  if (h.rawOutput().includes('\x1b[3J')) found.push('the scrollback was erased (ESC[3J)');
  const statusRows = rows.flatMap((row, index) => row.includes(STATUS) ? [index] : []);
  if (statusRows.length !== 1 || statusRows[0] !== rows.length - 1) found.push(`status line at rows [${statusRows.join(', ')}] of ${rows.length}`);
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
    const inline = seed % 4 === 0;
    // A terminal that shows OSC 8 links: transcript rows carry link sequences.
    const links = seed % 3 === 1;
    calls = 0;
    tags = 0;
    const model = new TurnModel();
    tui = await TuiHarness.start('src/tui-pi/index.ts', cols, rows, inline ? ['--inline'] : [], links ? { env: { TERM_PROGRAM: 'vscode' } } : {});
    await tui.waitFor('connected');
    tui.send(DRAFT); await tui.waitFor(DRAFT);
    const log = [`start ${cols}x${rows}${inline ? ' inline' : ''}${links ? ' links' : ''}`];
    let pending = 0;
    let pickerOpen = false;
    const agents: string[] = [];
    for (let n = 0; n < STEPS; n++) {
      const step = stepFrom(rand, pending, agents, pickerOpen, model, rows);
      log.push(step.label);
      await step.run(tui);
      step.model?.(model);
      if (step.decision) pending++;
      if (step.answer) pending--;
      if (step.picker) pickerOpen = step.picker === 'open';
      await settle();
      const broken = [...await violations(tui, pending > 0 || pickerOpen, inline), ...modelViolations(tui, model, pending)];
      if (broken.length) {
        expect.fail(`seed ${seed}, step ${n + 1} (${step.label}): ${broken.join('; ')}\nsteps: ${log.join(' → ')}\nrerun: TUI_FUZZ_SEED=${seed} npx vitest run tests/tui/invariants.e2e.test.ts\n${await tui.text()}`);
      }
    }
    // Answer until nothing runs: every message typed went out once, in the order typed.
    for (let n = 0; model.turn !== 'none' && n <= model.typed.length + 1; n++) {
      tui.event('chat.response', answerPayload(tui, model, `drain ${n}`));
      model.answer();
      await settle();
    }
    expect(model.queue, `seed ${seed}: queue left after draining`).toEqual([]);
    expect(sentTags(tui), `seed ${seed}: sends\nsteps: ${log.join(' → ')}`).toEqual(model.typed);
  });
});
