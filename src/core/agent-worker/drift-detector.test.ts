/**
 * Drift detection, modelled on the run-743d4b66 failure: a research child asked
 * about the World Cup spent 29 iterations writing Diátaxis documentation and
 * then declared success.
 */
import { describe, expect, test } from 'bun:test';
import { DriftDetector, driftTokens } from './drift-detector';

const FOOTBALL_BRIEF =
  'Find out which World Cup matches were played yesterday, the scores, and which teams play today and tomorrow.';

/** One iteration of the drift that actually happened. */
const DOC_WRITING = [
  { name: 'filesystem__write_file', arguments: { path: 'ai-docs/structure/DIATAXIS-DECISION.md', content: 'Diátaxis framework overview' } },
];

function feed(d: DriftDetector, calls: Parameters<DriftDetector['record']>[0], times: number) {
  let last = d.record(calls);
  for (let i = 1; i < times; i++) last = d.record(calls);
  return last;
}

describe('driftTokens', () => {
  test('keeps distinctive words and drops short ones', () => {
    const t = driftTokens('Find the World Cup scores');
    expect(t.has('world')).toBe(true);
    expect(t.has('scores')).toBe(true);
    expect(t.has('the')).toBe(false);
  });
});

describe('DriftDetector', () => {
  test('catches the 743d4b66 pattern: sustained unrelated file writing', () => {
    const d = new DriftDetector(FOOTBALL_BRIEF);
    // Nudge first — the agent gets told before it gets killed.
    expect(feed(d, DOC_WRITING, 4)).toEqual({ action: 'nudge', consecutive: 4 });
    expect(feed(d, DOC_WRITING, 4)).toEqual({ action: 'abort', consecutive: 8 });
  });

  test('on-task activity clears the counter', () => {
    const d = new DriftDetector(FOOTBALL_BRIEF);
    feed(d, DOC_WRITING, 3);
    // A single call that mentions the brief resets everything.
    expect(d.record([{ name: 'websearch__search', arguments: { query: 'World Cup scores yesterday' } }])).toEqual({
      action: 'none',
    });
    // Counter restarted, so three more off-brief iterations still do not nudge.
    expect(feed(d, DOC_WRITING, 3)).toEqual({ action: 'none' });
  });

  test('a single shared token is enough to count as on-task (biased to false negatives)', () => {
    const d = new DriftDetector(FOOTBALL_BRIEF);
    feed(d, DOC_WRITING, 3);
    expect(d.record([{ name: 'filesystem__read_file', arguments: { path: 'notes/matches.md' } }])).toEqual({
      action: 'none',
    });
  });

  test('nudges only once, then aborts', () => {
    const d = new DriftDetector(FOOTBALL_BRIEF);
    feed(d, DOC_WRITING, 4);
    // Iterations 5-7 stay quiet — no repeated nudging.
    expect(feed(d, DOC_WRITING, 3)).toEqual({ action: 'none' });
    expect(d.record(DOC_WRITING)).toEqual({ action: 'abort', consecutive: 8 });
  });

  test('a vague brief disables detection entirely', () => {
    // "fix it" has no distinctive tokens to judge against; every iteration
    // would look like drift.
    const d = new DriftDetector('fix it');
    expect(d.enabled).toBe(false);
    expect(feed(d, DOC_WRITING, 20)).toEqual({ action: 'none' });
  });

  test('iterations with no tool calls are neutral, not drift', () => {
    const d = new DriftDetector(FOOTBALL_BRIEF);
    feed(d, DOC_WRITING, 3);
    expect(d.record([])).toEqual({ action: 'none' });
    // Still at 3 — the empty iteration neither advanced nor reset it.
    expect(d.record(DOC_WRITING)).toEqual({ action: 'nudge', consecutive: 4 });
  });

  test('unserializable arguments are treated as on-task, never as drift', () => {
    const d = new DriftDetector(FOOTBALL_BRIEF);
    feed(d, DOC_WRITING, 3);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(d.record([{ name: 'x__y', arguments: circular }])).toEqual({ action: 'none' });
    expect(feed(d, DOC_WRITING, 3)).toEqual({ action: 'none' });
  });

  test('normal exploration does not trip it', () => {
    // A coding agent orienting itself: generic calls, but the brief's terms
    // show up in paths often enough to keep clearing the counter.
    const d = new DriftDetector('Fix the failing authentication tests in the login module');
    const exploration = [
      [{ name: 'shell__run', arguments: { command: 'ls -la' } }],
      [{ name: 'filesystem__list_directory', arguments: { path: '.' } }],
      [{ name: 'filesystem__read_file', arguments: { path: 'src/login/auth.ts' } }],
      [{ name: 'shell__run', arguments: { command: 'bun test' } }],
    ];
    for (const calls of exploration) expect(d.record(calls).action).toBe('none');
  });

  test('a SUSTAINED on-task run whose vocabulary drifts from the brief survives', () => {
    // The review scenario: the bug traces to a shared util whose path contains
    // none of the brief's nouns. Twelve iterations — past both thresholds.
    // Exact-token matching aborted this; prefix matching keeps `bun test`
    // clearing against the brief's "tests".
    const d = new DriftDetector('Fix the failing authentication tests in the login module');
    const debugging = [
      [{ name: 'filesystem__read_file', arguments: { path: 'src/utils/date-formatter.ts' } }],
      [{ name: 'filesystem__write_file', arguments: { path: 'src/utils/date-formatter.ts', content: 'patch' } }],
      [{ name: 'shell__run', arguments: { command: 'bun test' } }],
    ];
    for (let i = 0; i < 4; i++) {
      for (const calls of debugging) expect(d.record(calls).action).toBe('none');
    }
  });

  test('an orchestrator polling collect_children is neutral, never drift', () => {
    // A false abort here cascade-cancels the pending children the orchestrator
    // was waiting on — it would destroy the work it was collecting.
    const d = new DriftDetector('Research the World Cup fixtures and summarise them');
    const poll = [{ name: 'collect_children', arguments: { timeoutMs: 30000 } }];
    for (let i = 0; i < 20; i++) expect(d.record(poll).action).toBe('none');
    // Still neutral afterwards: the counter never moved, so genuine drift
    // still needs its full run of off-brief iterations.
    expect(feed(d, DOC_WRITING, 3)).toEqual({ action: 'none' });
  });

  test('a mixed iteration is judged on its non-coordination calls', () => {
    const d = new DriftDetector('Research the World Cup fixtures and summarise them');
    const mixed = [
      { name: 'collect_children', arguments: { timeoutMs: 1000 } },
      ...DOC_WRITING,
    ];
    expect(feed(d, mixed, 4)).toEqual({ action: 'nudge', consecutive: 4 });
  });

  test('oversized tool arguments are truncated before tokenizing', () => {
    const d = new DriftDetector('Research the World Cup fixtures and summarise them');
    // The brief term sits far past the arg cap, so it must NOT clear — proving
    // truncation happened rather than the whole blob being scanned.
    const huge = { path: 'ai-docs/page.md', content: `${'x'.repeat(20_000)} fixtures` };
    expect(d.record([{ name: 'filesystem__write_file', arguments: huge }]).action).toBe('none');
    expect(feed(d, [{ name: 'filesystem__write_file', arguments: huge }], 3)).toEqual({
      action: 'nudge',
      consecutive: 4,
    });
  });
});
