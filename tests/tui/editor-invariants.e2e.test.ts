/**
 * Invariants of the editor's screen under random keys, mouse, resizes and
 * agent edits.
 *
 * Each seed drives the real editor entry point through a random sequence:
 * typing (wide characters, emoji, combining marks, tabs), navigation and
 * selection keys, the editor's shortcuts (find, replace, project search, go
 * to line, soft wrap, new file, panes), clicks, drags, double clicks and
 * wheel notches anywhere on the screen (tabs, tree, dividers, scrollbar),
 * random resizes, and agent edits (to open files and new ones, with control
 * bytes, CRLF and 10 kB lines) answered with random review keys. After every
 * step the screen must hold:
 *
 *   - no row wider than the terminal (no row the terminal had to wrap);
 *   - the mode bar on the last row: the mode and focus, or a notice — never
 *     a row of the panes pushed down there;
 *   - the cursor inside the screen, and inside the editor pane when the
 *     editor has the focus and no overlay is open;
 *   - no control byte written to the terminal other than in an escape
 *     sequence, CR, LF or backspace — a file's own control bytes are drawn
 *     as control pictures;
 *   - the alternate screen still showing, and no scrollback erase.
 *
 *   TUI_FUZZ_SEEDS=200 npx vitest run tests/tui/editor-invariants   # more seeds
 *   TUI_FUZZ_SEED=17 npx vitest run tests/tui/editor-invariants     # one seed
 *
 * A failure names the seed, the step and the action, and prints the screen.
 * The quit keys are left out (Ctrl+Q, Ctrl+C), so a run never ends itself.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TuiHarness } from './harness';

const SEEDS = process.env.TUI_FUZZ_SEED
  ? [Number(process.env.TUI_FUZZ_SEED)]
  : Array.from({ length: Number(process.env.TUI_FUZZ_SEEDS ?? 6) }, (_, n) => n + 1);
const STEPS = Number(process.env.TUI_FUZZ_STEPS ?? 30);

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
function pick<T>(rand: () => number, items: readonly T[]): T { return items[Math.floor(rand() * items.length)] as T; }
const int = (rand: () => number, lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

// Typed at the keyboard: printable only (a control byte is a shortcut, and two of them quit).
// Spacing marks of Devanagari-like scripts are a known width disagreement and are left out.
const TYPED = ['x', 'word ', 'const a = 1;', '世界', '한국어', 'Ａｂ', '🐙', '✅', '👍🏽', '🇫🇷', 'é', '\t', '(', ')', '{', '}', 'ß', '…'];
// In files and agent edits anything goes.
const CONTENT = [...TYPED, '\r', '\r\n', '\n', '\n\n', '\x00', '\x07', '\x08', '\x0b', '\x1b', '\x7f', '\x85', '\x9b',
  '\x1b[2J', '\x1b[H', '\x1b[10A', '\x1b[31mred\x1b[0m', '\x1b]0;title\x07', '‮', '​', '️', '👨‍👩‍👧'];

function contentFrom(rand: () => number): string {
  const roll = rand();
  if (roll < 0.08) return pick(rand, CONTENT).repeat(Math.ceil(10_240 / 4)).slice(0, 10_240) + 'END';
  return Array.from({ length: int(rand, 1, 40) }, () => Array.from({ length: int(rand, 1, 6) }, () => pick(rand, CONTENT)).join('')).join(rand() < 0.3 ? '\r\n' : '\n');
}

const KEYS: ReadonlyArray<[string, string]> = [
  ['up', '\x1b[A'], ['down', '\x1b[B'], ['left', '\x1b[D'], ['right', '\x1b[C'],
  ['shift+up', '\x1b[1;2A'], ['shift+down', '\x1b[1;2B'], ['shift+right', '\x1b[1;2C'], ['ctrl+shift+right', '\x1b[1;6C'],
  ['home', '\x1b[H'], ['end', '\x1b[F'], ['pageUp', '\x1b[5~'], ['pageDown', '\x1b[6~'], ['ctrl+home', '\x1b[1;5H'], ['ctrl+end', '\x1b[1;5F'],
  ['enter', '\r'], ['backspace', '\x7f'], ['delete', '\x1b[3~'], ['tab', '\t'], ['escape', '\x1b'],
  ['ctrl+z', '\x1a'], ['ctrl+y', '\x19'], ['ctrl+x', '\x18'], ['ctrl+v', '\x16'],
  ['alt+z wrap', '\x1bz'], ['alt+m vim', '\x1bm'], ['ctrl+\\ focus', '\x1c'], ['ctrl+b tree', '\x02'], ['alt+j chat', '\x1bj'],
  ['alt+. next buffer', '\x1b.'], ['ctrl+w close', '\x17'], ['ctrl+o open', '\x0f'], ['ctrl+f find', '\x06'], ['alt+r replace', '\x1br'],
  ['alt+g project search', '\x1bg'], ['ctrl+g go to line', '\x07'], ['alt+n new file', '\x1bn'], ['f5 hotkeys', '\x1b[15~'],
  ['alt+y resolve', '\x1by'], ['review y', 'y'], ['review n', 'n'], ['review ]', ']'], ['review z', 'z'], ['review a', 'a'], ['review r', 'r'], ['alt+enter', '\x1b\r'],
];

type Step = { label: string; run: (h: TuiHarness) => void };

function stepFrom(rand: () => number, size: { cols: number; rows: number }, project: string): Step {
  const roll = rand();
  const x = () => int(rand, 1, size.cols);
  const y = () => int(rand, 1, size.rows);
  if (roll < 0.18) { const text = Array.from({ length: int(rand, 1, 4) }, () => pick(rand, TYPED)).join(''); return { label: `type ${JSON.stringify(text)}`, run: h => h.send(text) }; }
  if (roll < 0.5) { const [name, key] = pick(rand, KEYS); return { label: name, run: h => h.send(key) }; }
  if (roll < 0.58) { const cx = x(); const cy = y(); return { label: `click ${cx},${cy}`, run: h => h.send(`\x1b[<0;${cx};${cy}M\x1b[<0;${cx};${cy}m`) }; }
  if (roll < 0.62) { const cx = x(); const cy = y(); return { label: `double click ${cx},${cy}`, run: h => h.send(`\x1b[<0;${cx};${cy}M\x1b[<0;${cx};${cy}m\x1b[<0;${cx};${cy}M\x1b[<0;${cx};${cy}m`) }; }
  if (roll < 0.68) {
    const [ax, ay, bx, by] = [x(), y(), x(), int(rand, 0, size.rows + 3)];
    return { label: `drag ${ax},${ay} → ${bx},${by}`, run: h => h.send(`\x1b[<0;${ax};${ay}M\x1b[<32;${Math.round((ax + bx) / 2)};${Math.round((ay + by) / 2)}M\x1b[<32;${bx};${Math.max(1, by)}M\x1b[<0;${bx};${Math.max(1, by)}m`) };
  }
  if (roll < 0.74) { const cx = x(); const cy = y(); const up = rand() < 0.5; return { label: `wheel ${up ? 'up' : 'down'} at ${cx},${cy}`, run: h => h.send(`\x1b[<${up ? 64 : 65};${cx};${cy}M`) }; }
  if (roll < 0.8) {
    const cols = int(rand, 30, 160); const rows = int(rand, 8, 50);
    return { label: `resize ${cols}x${rows}`, run: h => { size.cols = cols; size.rows = rows; h.resize(cols, rows); } };
  }
  if (roll < 0.9) {
    const content = contentFrom(rand); const path = rand() < 0.6 ? 'example.ts' : `agent-${int(rand, 1, 4)}.txt`;
    return { label: `agent writes ${path}`, run: h => h.event('agent.action', { agentId: 'root', data: { type: 'tool_call', toolName: 'write_file', args: { path, content } } }) };
  }
  if (roll < 0.95) {
    const content = contentFrom(rand);
    return { label: 'example.ts changed on disk', run: () => writeFileSync(join(project, 'example.ts'), content) };
  }
  const name = pick(rand, ['example.ts', 'ctrl.txt', 'wide.md', 'agent-1.txt']);
  return { label: `open ${name}`, run: h => h.send(`\x0f${name}\r`) };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 80));

/** Escape sequences the app writes: CSI, OSC (BEL or ST), DCS/APC/PM/SOS strings, two-byte escapes. */
const SEQUENCES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[P_^X][^\x1b]*\x1b\\|[ -/]*[0-~])/g;
const STRAY_CONTROLS = /[\x00-\x07\x0b-\x0c\x0e-\x1a\x1c-\x1f\x7f\x80-\x9f]|\x1b/;
const MODE_BAR = /^(EDIT|VIM (NORMAL|INSERT|VISUAL))  focus:(editor|tree|chat)/;
/** Something open over the panes: a box, or one of the prompts. */
const OVERLAY = /[┌└]─|Unsaved changes|File changed on disk|Save .* as|Go to line|New file|Rename |Delete .*\?|Agent edit:|Keep this|Allow/;

async function violations(h: TuiHarness, checked: { bytes: number }): Promise<string[]> {
  const rows = (await h.text()).split('\n');
  const found: string[] = [];
  const buffer = h.screen.buffer.active;
  if (buffer.type !== 'alternate') found.push(`showing the ${buffer.type} buffer`);
  const raw = h.rawOutput();
  if (raw.includes('\x1b[3J')) found.push('the scrollback was erased (ESC[3J)');
  // Only what was written since the last check: an earlier violation is reported once.
  const fresh = raw.slice(checked.bytes).replace(SEQUENCES, '');
  checked.bytes = raw.length;
  const stray = STRAY_CONTROLS.exec(fresh);
  if (stray) found.push(`a control byte 0x${stray[0].charCodeAt(0).toString(16)} was written outside an escape sequence: ${JSON.stringify(fresh.slice(Math.max(0, stray.index - 20), stray.index + 20))}`);
  for (let row = 0; row < h.screen.rows; row++) {
    if (buffer.getLine(buffer.viewportY + row)?.isWrapped) found.push(`row ${row - 1} was wider than ${h.screen.cols} columns and wrapped`);
  }
  const last = rows[rows.length - 1] ?? '';
  const header = rows.findIndex(line => /[▸ ] (Files|Editor|Chat)/.test(line));
  const paneDividers = header < 0 ? [] : [...rows[header]].flatMap((ch, i) => (ch === '│' ? [i] : []));
  const looksLikePane = paneDividers.some(col => last[col] === '│') || /^\s*\d+ |^~/.test(last);
  if (!MODE_BAR.test(last) && looksLikePane) found.push(`the last row is a row of the panes, not the mode bar: ${JSON.stringify(last)}`);
  if (header < 0 && !rows.some(line => OVERLAY.test(line))) found.push('no pane titles on screen');
  if (buffer.cursorY < 0 || buffer.cursorY >= h.screen.rows || buffer.cursorX < 0 || buffer.cursorX > h.screen.cols) found.push(`cursor at ${buffer.cursorX},${buffer.cursorY} outside the screen`);
  if (/focus:editor/.test(last) && header >= 0 && !rows.some(line => OVERLAY.test(line))) {
    // The editor's rows: below the title row and the tab strip, above the mode bar; its columns: between the dividers.
    const titles = rows[header];
    const start = titles.indexOf('Editor');
    const left = start < 0 ? 0 : (titles.lastIndexOf('│', start) + 1);
    const nextDivider = start < 0 ? -1 : titles.indexOf('│', start);
    const right = nextDivider < 0 ? h.screen.cols : nextDivider;
    const inRows = buffer.cursorY >= header + 2 && buffer.cursorY < rows.length - 1;
    const inCols = buffer.cursorX >= left && buffer.cursorX <= right;
    const empty = rows.some(line => line.includes('No buffer open'));
    // The cursor's line scrolled out of view (the wheel scrolls without moving it): no cursor to place.
    const cursorLine = /  L(\d+):\d+/.exec(last)?.[1];
    const shownLines = rows.slice(header + 2, rows.length - 1).map(line => /^\s*(\d+) /.exec(line.slice(left, right))?.[1]).filter(Boolean);
    const cursorShown = cursorLine === undefined || shownLines.includes(cursorLine);
    if (!empty && cursorShown && (!inRows || !inCols)) found.push(`the editor has the focus but the cursor is at ${buffer.cursorX},${buffer.cursorY}, outside its pane (columns ${left}–${right}, rows ${header + 2}–${rows.length - 2})`);
  }
  return found;
}

describe.skipIf(process.platform === 'win32')('editor screen invariants under random keys, mouse, resizes and agent edits', () => {
  test.each(SEEDS)('seed %i', async seed => {
    const rand = random(seed);
    const size = { cols: int(rand, 40, 160), rows: int(rand, 12, 45) };
    tui = await TuiHarness.start('src/tui-editor/index.ts', size.cols, size.rows);
    const project = tui.project;
    writeFileSync(join(project, 'example.ts'), `${Array.from({ length: 60 }, (_, i) => `const line${i} = ${i}; // ${pick(rand, TYPED)}`).join('\n')}\n`);
    writeFileSync(join(project, 'ctrl.txt'), 'bell \x07 clear \x1b[2J del \x7f\r\nlone \r cr\n');
    writeFileSync(join(project, 'wide.md'), `${'世界🐙 '.repeat(80)}\n\ttabbed\n`);
    await tui.waitFor('focus:editor'); await tui.waitFor('connected');
    tui.send('\x0fexample.ts\r'); await tui.waitFor('line0');
    const checked = { bytes: 0 };
    const log = [`start ${size.cols}x${size.rows}`];
    for (let n = 0; n < STEPS; n++) {
      const step = stepFrom(rand, size, project);
      log.push(step.label);
      step.run(tui);
      await settle();
      if (tui.proc.exitCode !== null) expect.fail(`seed ${seed}, step ${n + 1} (${step.label}): the editor exited (${tui.proc.exitCode})\nsteps: ${log.join(' → ')}\n${tui.stderr()}`);
      const broken = await violations(tui, checked);
      if (broken.length) {
        expect.fail(`seed ${seed}, step ${n + 1} (${step.label}): ${broken.join('; ')}\nsteps: ${log.join(' → ')}\nrerun: TUI_FUZZ_SEED=${seed} npx vitest run tests/tui/editor-invariants.e2e.test.ts\n${await tui.text()}`);
      }
    }
  });
});
