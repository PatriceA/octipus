import { expect, test } from 'vitest';
import { compactPipelineStatus, pipelineDenialHistory, pipelineNewDenialSummary } from './pipeline-status';

test('old denials are distinguished from a later repair and are not republished after resume', () => {
  const deniedRequests = Array.from({ length: 32 }, () => ({ at: '2026-11-02T17:17:23.160Z', toolId: 'shell', action: 'execute', command: 'old denied command' }));
  const pipeline = { status: 'paused' as const, metadata: { deniedRequests, policyRepair: { resolvedAt: '2026-11-02T17:27:49.560Z' } } };
  expect(pipelineDenialHistory(pipeline)).toMatchObject({ total: 32, lastDeniedAt: '2026-11-02T17:17:23.160Z', lastRecordedRepairAt: '2026-11-02T17:27:49.560Z', denialsSinceRecordedRepair: 0 });
  expect(pipelineNewDenialSummary(pipeline, 32)).toBeUndefined();
  deniedRequests.push({ at: '2026-11-02T18:00:00.000Z', toolId: 'shell', action: 'execute', command: 'new denied command' });
  const summary = pipelineNewDenialSummary(pipeline, 32)!;
  expect(summary).toMatchObject({ newCount: 1, totalCount: 33 });
  expect(summary.body).toContain('2026-11-02T18:00:00.000Z');
  expect(summary.body).toContain('new denied command');
  expect(summary.body).not.toContain('old denied command');
  expect(pipelineDenialHistory(pipeline).denialsSinceRecordedRepair).toBe(1);
});

test('legacy denials without timestamps are explicit unknowns', () => {
  expect(pipelineDenialHistory({ metadata: { deniedRequests: [{ command: 'legacy' }] } })).toMatchObject({ total: 1, lastDeniedAt: null, lastRecordedRepairAt: null, denialsSinceRecordedRepair: null, undatedDenialCount: 1 });
});

test('large status evidence stays parseable JSON below the bridge text limit', () => {
  const status = { id: 'pipeline', status: 'paused', resumeAfter: '2099-11-10T11:40:18Z',
    history: Array.from({ length: 50 }, (_, i) => ({ seq: i + 1, output: 'evidence '.repeat(10000) })),
    items: Array.from({ length: 30 }, (_, i) => ({ id: 'item-' + i, status: 'pending', result: 'details '.repeat(2000), stages: [{ events: Array(50).fill('event detail'.repeat(1000)) }] })),
    recoveryRequired: [{ id: 'uncertain-record', toolName: 'shell__run', status: 'uncertain' }] };
  const result = compactPipelineStatus(status);
  const serialized = JSON.stringify(result);
  expect(serialized.length).toBeLessThan(40001);
  expect(JSON.parse(serialized)).toMatchObject({ id: 'pipeline', resumeAfter: status.resumeAfter, outputCompacted: true, recoveryRequired: [{ id: 'uncertain-record', status: 'uncertain' }] });
  expect(result.history.at(-1)?.seq).toBe(50);
});

test('many queued edits cannot overflow status JSON through nested acceptance arrays', () => {
  const result = compactPipelineStatus({ id: 'p', status: 'paused', history: [], items: [], pendingItemEdits: Array.from({ length: 20 }, () => ({ add: Array.from({ length: 100 }, () => ({ title: 'a'.repeat(500), acceptance: Array(100).fill('acceptance'.repeat(100)) })), evidence: 'decision'.repeat(500) })) });
  expect(JSON.stringify(result).length).toBeLessThan(40001);
  expect(result.outputCompacted).toBe(true);
});
