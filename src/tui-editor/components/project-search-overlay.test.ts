import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { visibleWidth } from '@/tui-kit';
import type { ProjectHit, ProjectSearchDone } from '../project-search';
import { ProjectSearchOverlay } from './project-search-overlay';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'search-overlay-'));
  writeFileSync(join(root, 'a.ts'), 'one\ntwo\nconst target = 1;\nfour\nfive\n');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07|\x1b_pi:\/?fc\x07/g, '');

function setup() {
  const opened: ProjectHit[] = [];
  let finish: (done: ProjectSearchDone) => void = () => {};
  let deliver: (hits: ProjectHit[]) => void = () => {};
  const queries: string[] = [];
  let closed = false;
  const overlay = new ProjectSearchOverlay({
    root,
    onOpen: (hit) => opened.push(hit),
    onClose: () => { closed = true; },
    onUpdate: () => {},
    search: (_root, query, _options, onHits) => {
      queries.push(query);
      deliver = onHits;
      return { done: new Promise((resolve) => { finish = resolve; }), cancel: () => {} };
    },
  });
  overlay.setMaxRows(24);
  return { overlay, opened, queries, deliver: (h: ProjectHit[]) => deliver(h), finish: (d: ProjectSearchDone) => finish(d), get closed() { return closed; } };
}

const hit = (line: number, text: string, col: number, length: number): ProjectHit => ({ path: join(root, 'a.ts'), line, col, length, text });

test('Enter searches; results arrive while it runs; Enter on the same query opens the selected match', async () => {
  const ctx = setup();
  for (const c of 'target') ctx.overlay.handleInput(c);
  ctx.overlay.handleInput('\r');
  expect(ctx.queries).toEqual(['target']);
  expect(strip(ctx.overlay.render(80).join('\n'))).toContain('searching… 0 so far');
  ctx.deliver([hit(2, 'const target = 1;', 6, 6)]);
  ctx.finish({ source: 'rg', truncated: false });
  await new Promise((r) => setTimeout(r, 0));
  const text = strip(ctx.overlay.render(80).join('\n'));
  expect(text).toContain('1 match in 1 file · ripgrep');
  expect(text).toContain('a.ts:3  const target = 1;');
  // The preview shows the lines around the match, numbered.
  expect(text).toMatch(/2 two[\s\S]*3 const target = 1;[\s\S]*4 four/);
  ctx.overlay.handleInput('\r');
  expect(ctx.opened).toEqual([hit(2, 'const target = 1;', 6, 6)]);
});

test('Up and Down choose a result; a changed query searches again; Esc closes', async () => {
  const ctx = setup();
  for (const c of 'o') ctx.overlay.handleInput(c);
  ctx.overlay.handleInput('\r');
  ctx.deliver([hit(0, 'one', 0, 1), hit(1, 'two', 2, 1), hit(3, 'four', 1, 1)]);
  ctx.overlay.handleInput('\x1b[B'); ctx.overlay.handleInput('\x1b[B');
  expect(ctx.overlay.getSelected()).toBe(2);
  ctx.overlay.handleInput('\x1b[A');
  expect(ctx.overlay.getSelected()).toBe(1);
  ctx.overlay.handleInput('n');
  ctx.overlay.handleInput('\r');
  expect(ctx.queries).toEqual(['o', 'on']);
  expect(ctx.overlay.getHits()).toEqual([]);
  ctx.overlay.handleInput('\x1b');
  expect(ctx.closed).toBe(true);
});

test('every row fits the width, with a long line cut around its match', () => {
  const ctx = setup();
  ctx.overlay.handleInput('x'); ctx.overlay.handleInput('\r');
  ctx.deliver([hit(0, `${'a'.repeat(300)}x${'b'.repeat(300)}`, 300, 1)]);
  const rows = ctx.overlay.render(70);
  for (const row of rows) expect(visibleWidth(row)).toBe(70);
  expect(strip(rows.join('\n'))).toMatch(/…a+xb+/);
});
