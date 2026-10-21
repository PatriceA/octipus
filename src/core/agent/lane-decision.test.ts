import { beforeEach, expect, test, vi } from 'vitest';
import { decide } from '@/models/decision';
import { selectLaneWithDecision } from './lane-intent';
vi.mock('@/models/decision', async original => ({
  ...await original<typeof import('@/models/decision')>(), decide: vi.fn(),
}));
beforeEach(() => vi.mocked(decide).mockReset());
test('a confident decision replaces the uncertain heuristic', async () => {
  vi.mocked(decide).mockResolvedValue({ lane: { type: 'choice', choice: 'research', probabilities: { research: 0.95 }, confidence: 0.95 } });
  expect((await selectLaneWithDecision('look into this')).lane).toBe('research');
});
test('unavailable or low-confidence decisions retain heuristic routing', async () => {
  vi.mocked(decide).mockResolvedValue(null);
  expect((await selectLaneWithDecision('look at file.ts')).lane).toBe('build');
  expect((await selectLaneWithDecision('hello')).lane).toBe('everyday');
});
test('confident keyword routing does not call the decision server', async () => {
  expect((await selectLaneWithDecision('implement', { type: 'task', topic: 'coding', confidence: 0.9 })).lane).toBe('build');
  expect(decide).not.toHaveBeenCalled();
});
