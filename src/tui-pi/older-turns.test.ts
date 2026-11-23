/** Older turns paged in from the server as the reader scrolls up (docs/plans/tui-modernization.md §5.1, "Long sessions"). */
import { describe, expect, test, vi } from 'vitest';
import { MessagesPane } from './components/messages-pane';
import { createTranscriptView } from './components/transcript-view';
import { OLDER_PAGE, OlderTurns, type HistoryRow } from './older-turns';

const strip = (lines: readonly string[]) => lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));
const row = (n: number): HistoryRow => ({ id: `id-${n}`, role: n % 2 ? 'assistant' : 'user', content: `turn ${n}`, at: new Date(1_700_000_000_000 + n * 1000).toISOString() });
const page = (from: number, to: number, hasMore: boolean) => ({
  messages: Array.from({ length: to - from }, (_, i) => { const r = row(from + i); return { id: r.id, role: r.role, content: r.content, createdAt: r.at }; }),
  hasMore,
});

/** A pane replayed with turns [from, to) and the controller over it, with a fake REST read. */
function setup(from: number, to: number, options: { maxVisible?: number; maxItems?: number } = {}) {
  const pane = new MessagesPane({ maxVisible: options.maxVisible ?? 8, maxItems: options.maxItems });
  const replay = Array.from({ length: to - from }, (_, i) => row(from + i));
  for (const r of replay) pane.push({ role: r.role, content: r.content, timestamp: new Date(r.at) });
  const pending: Array<{ path: string; resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
  const getJson = vi.fn(<T,>(path: string) => new Promise<T>((resolve, reject) => { pending.push({ path, resolve: resolve as (v: unknown) => void, reject }); }));
  const changed = vi.fn();
  let now = 0;
  const older = new OlderTurns(pane, getJson as <T>(path: string) => Promise<T>, () => 'sess-1', changed, () => now);
  older.replayed(replay);
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  return { pane, older, getJson, pending, changed, settle, tick: (ms: number) => { now += ms; } };
}

describe('the controller', () => {
  test('reaching the top asks for the page before the oldest replayed message, with the web\'s paging route', async () => {
    const t = setup(100, 150);
    expect(strip(t.pane.documentLines(80))[0]).toContain('Older messages are on the server');
    t.pane.reachedTop();
    t.pane.reachedTop(); // a second reach while loading asks nothing more
    expect(t.getJson).toHaveBeenCalledTimes(1);
    const url = new URL(`http://x${t.pending[0]?.path}`);
    expect(url.pathname).toBe('/sessions/sess-1/messages');
    expect(Object.fromEntries(url.searchParams)).toEqual({ page: 'true', limit: String(OLDER_PAGE), before: 'id-100', roles: 'user,assistant', aggregate: 'false' });
    expect(strip(t.pane.documentLines(80))[0]).toContain('Loading older messages…');
    t.pending[0]?.resolve(page(60, 100, true));
    await t.settle();
    const lines = strip(t.pane.documentLines(80)).join('\n');
    expect(lines.indexOf('turn 60')).toBeLessThan(lines.indexOf('turn 100'));
    expect(t.pane.entries().map(e => e.content).slice(0, 2)).toEqual(['turn 60', 'turn 61']);
    // The next page continues from the oldest one loaded.
    t.pane.reachedTop();
    expect(t.pending[1]?.path).toContain('before=id-60');
    t.pending[1]?.resolve(page(0, 60, false));
    await t.settle();
    expect(t.pane.getOlder()).toEqual({ state: 'none' });
    expect(strip(t.pane.documentLines(80))[0]).not.toContain('server');
    t.pane.reachedTop();
    expect(t.getJson).toHaveBeenCalledTimes(2);
  });

  test('a failed load is said at the top and asked again on a later reach, not in a loop', async () => {
    const t = setup(10, 20);
    t.pane.reachedTop();
    t.pending[0]?.reject(new Error('HTTP 502'));
    await t.settle();
    expect(strip(t.pane.documentLines(80))[0]).toContain('Older messages could not be loaded: HTTP 502');
    t.pane.reachedTop();
    expect(t.getJson).toHaveBeenCalledTimes(1);
    t.tick(5000);
    t.pane.reachedTop();
    expect(t.getJson).toHaveBeenCalledTimes(2);
  });

  test('a page that arrives after the transcript was replaced or cleared is dropped', async () => {
    const t = setup(10, 20);
    t.pane.reachedTop();
    t.pane.reset();
    t.older.reset();
    t.pending[0]?.resolve(page(0, 10, false));
    await t.settle();
    expect(t.pane.entries()).toEqual([]);
  });

  test('a replay with no messages, or one without ids (an older server), offers nothing to load', () => {
    const pane = new MessagesPane();
    const getJson = vi.fn();
    const older = new OlderTurns(pane, getJson as <T>(path: string) => Promise<T>, () => 's', () => {});
    older.replayed([]);
    pane.reachedTop();
    older.replayed([{ role: 'user', content: 'hi', at: new Date().toISOString() }]);
    pane.reachedTop();
    expect(getJson).not.toHaveBeenCalled();
    expect(pane.getOlder()).toEqual({ state: 'none' });
  });

  test('the memory cap bounds what is loaded: the newest of the page go in, and loading stops', async () => {
    const t = setup(100, 140, { maxItems: 50 });
    t.pane.reachedTop();
    t.pending[0]?.resolve(page(60, 100, true));
    await t.settle();
    expect(t.pane.size().kept).toBe(50);
    expect(t.pane.entries()[0]?.content).toBe('turn 90');
    expect(strip(t.pane.documentLines(80))[0]).toContain('this transcript keeps at most 50');
    t.pane.reachedTop();
    expect(t.getJson).toHaveBeenCalledTimes(1);
  });
});

describe('where the reader is', () => {
  test('inline: PageUp past the oldest row asks, and the rows being read stay put when the page comes in', async () => {
    const t = setup(100, 130, { maxVisible: 8 });
    t.pane.render(60);
    while (t.pane.scrollUp()) { /* to the top */ }
    expect(t.getJson).toHaveBeenCalledTimes(1);
    const before = strip(t.pane.render(60)).slice(0, -1);
    t.pending[0]?.resolve(page(80, 100, true));
    await t.settle();
    expect(strip(t.pane.render(60)).slice(0, -1).slice(1)).toEqual(before.slice(1)); // the notice row above may change
    expect(t.pane.scrollUp(1000)).toBe(true);
    expect(strip(t.pane.render(60)).join('\n')).toContain('turn 80');
  });

  test('alternate screen: the top in view asks; the page goes in above without moving what is on screen', async () => {
    const t = setup(100, 160);
    const view = createTranscriptView(t.pane);
    const layout = () => {
      const lines = view.document.render(60);
      view.updateLayout(lines.length, 8, () => {});
      return strip(lines.slice(view.scrollTop, view.scrollTop + 8));
    };
    layout();
    expect(t.getJson).not.toHaveBeenCalled(); // reading the latest, far from the top
    view.scrollTo(3);
    const reading = layout().slice(1);
    expect(t.getJson).toHaveBeenCalledTimes(1);
    t.pending[0]?.resolve(page(40, 100, true));
    await t.settle();
    expect(layout().slice(1)).toEqual(reading);
    view.scrollToStart();
    layout();
    expect(t.getJson).toHaveBeenCalledTimes(2);
  });

  test('a short transcript that fits the screen fills itself from the server', () => {
    const t = setup(10, 12);
    const view = createTranscriptView(t.pane);
    const lines = view.document.render(60);
    view.updateLayout(lines.length, 20, () => {});
    view.document.render(60);
    expect(t.getJson).toHaveBeenCalledTimes(1);
  });
});
