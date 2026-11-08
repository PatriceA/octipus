/**
 * The run view's outcome: files come only from recorded writes; a file the
 * answer says it saved is confirmed only by one; checks are the ones that
 * judged this run.
 */
import { expect, test, vi } from 'vitest';

const at = (hhmm: string) => new Date(`2026-11-08T${hhmm}:00Z`);
const fixture = vi.hoisted(() => ({ events: [] as unknown[], evidence: [] as unknown[] }));
vi.mock('@/db/repositories/agent-event-repository', () => ({ agentEventRepository: { outcomeEvents: async () => fixture.events } }));
vi.mock('@/db/repositories/verification-evidence-repository', () => ({ verificationEvidenceRepository: { listForSession: async () => fixture.evidence } }));
import { checksForRun, claimedPaths, confirmClaims, readRunOutcome } from './run-outcome';

test('a claim is a path after a save verb, in backticks or plain; other mentions are not claims', () => {
  expect(claimedPaths('I saved the notes to `out/release-notes.md` and wrote report.pdf. See also `src/app.ts` and https://x.io/a.html.')).toEqual(['out/release-notes.md', 'report.pdf']);
  expect(claimedPaths('Saved it as summary.csv, then created `charts/q3.png`.')).toEqual(['charts/q3.png', 'summary.csv']);
  expect(claimedPaths('The config lives in settings.json.')).toEqual([]);
});

test('a recorded write confirms a claim even after write_file relocated it', () => {
  expect(confirmClaims(['release-notes.md', 'out/summary.csv', 'missing.pdf'], ['/data/sessions/s1/output/release-notes.md', '/workspace/out/summary.csv'])).toEqual([
    { path: 'release-notes.md', confirmed: true },
    { path: 'out/summary.csv', confirmed: true },
    { path: 'missing.pdf', confirmed: false },
  ]);
});

const row = (over: Record<string, unknown>) => ({ id: 'e', sessionId: 's', pipelineId: null, stage: null, nodeId: null, kind: 'side_effect', passed: true, confidence: null, detail: {}, createdAt: at('09:45'), ...over });

test('a worker is judged by checks on its id or node, or its pipeline in its lifetime; the root by its turn', () => {
  const rows = [
    row({ id: '1', nodeId: 'w1', detail: { reason: 'no files changed' }, passed: false }),
    row({ id: '2', nodeId: 'other' }),
    row({ id: '3', pipelineId: 'p1', stage: 'draft', kind: 'qa_verdict', detail: { issues: ['a', 'b'] } }),
    row({ id: '4', pipelineId: 'p1', createdAt: at('11:00') }),
    row({ id: '5', kind: 'pre_verify', detail: { command: 'npm test', exitCode: 0 }, createdAt: at('09:50') }),
  ] as never[];
  const worker = { id: 'w1', swarmNodeId: null, createdAt: at('09:40'), completedAt: at('09:48'), origin: { source: 'pipeline' as const, pipelineId: 'p1' } };
  expect(checksForRun(worker, false, rows).map((c) => [c.kind, c.passed, c.summary])).toEqual([
    ['side_effect', false, 'no files changed'],
    ['qa_verdict', true, '2 issues'],
  ]);
  const rootRun = { id: 'r', swarmNodeId: null, createdAt: at('09:40'), completedAt: at('09:50'), origin: null };
  expect(checksForRun(rootRun, true, rows).map((c) => c.summary)).toContain('npm test · exit 0');
  expect(checksForRun(rootRun, true, rows)).toHaveLength(4);
});

test('the outcome reads files from recorded writes and flags a claimed file nobody wrote', async () => {
  fixture.events = [
    { type: 'action', data: { type: 'file_change', action: 'write', path: '/out/notes.md' }, createdAt: at('09:42') },
    { type: 'action', data: { type: 'file_change', action: 'edit', path: '/out/notes.md' }, createdAt: at('09:43') },
    { type: 'action', data: { type: 'file_change', action: 'delete', path: '/out/draft.md' }, createdAt: at('09:44') },
    { type: 'complete', data: { result: 'Done. I saved `notes.md` and wrote `chart.png`. Also saved draft.md.' }, createdAt: at('09:45') },
  ];
  fixture.evidence = [];
  const agent = { id: 'w1', sessionId: 's', swarmNodeId: null, createdAt: at('09:40'), completedAt: at('09:45'), origin: null, metadata: {}, error: null,
    durationMs: 300_000, totalTokens: 12_000, toolCalls: [{ name: 'read_file', count: 2 }, { name: 'write_file', count: 3 }] };
  const o = await readRunOutcome(agent as never, false, 'completed', 0.04);
  expect(o.files).toEqual([
    { path: '/out/notes.md', action: 'edit', at: at('09:43').toISOString() },
    { path: '/out/draft.md', action: 'delete', at: at('09:44').toISOString() },
  ]);
  // A deleted file does not confirm a claim to have saved it.
  expect(o.claims).toEqual([{ path: 'notes.md', confirmed: true }, { path: 'chart.png', confirmed: false }, { path: 'draft.md', confirmed: false }]);
  expect(o).toMatchObject({ status: 'completed', costUsd: 0.04, durationMs: 300_000, answerClipped: false, toolCalls: [{ name: 'write_file', count: 3 }, { name: 'read_file', count: 2 }] });
});

test('a long answer is clipped and says so; a failed run carries its error', async () => {
  fixture.events = [{ type: 'error', data: { error: 'Budget exceeded' }, createdAt: at('09:45') }, { type: 'complete', data: { result: 'x'.repeat(5_000) }, createdAt: at('09:46') }];
  const agent = { id: 'w1', sessionId: 's', swarmNodeId: null, createdAt: at('09:40'), completedAt: null, origin: null, metadata: {}, error: null, durationMs: null, totalTokens: 0, toolCalls: [] };
  const o = await readRunOutcome(agent as never, false, 'failed', null);
  expect(o).toMatchObject({ error: 'Budget exceeded', answerClipped: true, costUsd: null, claims: [] });
  expect(o.answer).toHaveLength(4_000);
});
