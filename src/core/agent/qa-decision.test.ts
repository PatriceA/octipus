import { beforeEach, expect, test, vi } from 'vitest';
import { decide } from '@/models/decision';
import { applyDecisionQaVerdict } from './qa-decision';
vi.mock('@/models/decision', () => ({ decide: vi.fn() }));
beforeEach(() => vi.mocked(decide).mockReset());
test('a confident blocking finding rejects a contradictory pass without discarding evidence', async () => {
  vi.mocked(decide).mockResolvedValue({ passed: { type: 'noul', p: 0.05, confidence: 0.95 } });
  const out = await applyDecisionQaVerdict('blocking issues', { passed: true, issues: [], source: 'json' });
  expect(out.passed).toBe(false);
  expect(out.source).toBe('json');
  expect(out.issues).toHaveLength(1);
});
test('a failed audit is never promoted by a model', async () => {
  const failed = { passed: false, issues: ['test failed'] };
  expect(await applyDecisionQaVerdict('report', failed)).toBe(failed);
  expect(decide).not.toHaveBeenCalled();
});
test.each([null, { passed: { type: 'noul' as const, p: 0.95, confidence: 0.95 } }])('unavailable decisions and approvals retain the parsed verdict for the evidence gate', async answer => {
  vi.mocked(decide).mockResolvedValue(answer);
  const parsed = { passed: true, issues: [] };
  expect(await applyDecisionQaVerdict('report', parsed)).toBe(parsed);
});
