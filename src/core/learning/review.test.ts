import { expect, test } from 'vitest';
import { boundEvidence, MAX_EVIDENCE_CHARS, type LearningEvidence } from './evidence';
import { parseLearningReview } from './review';
import { reviewDue, planLearningTrigger } from './triggers';
import { emptyWorkPlan, planUpdateSchema, reviseWorkPlan } from '@/shared/work-plan';

const initial = reviseWorkPlan(emptyWorkPlan(), planUpdateSchema.parse({ revision: 0, title: 'Fix', goal: 'Fix regression', summary: 'Start',
  steps: [{ id: 'a', title: 'Diagnose', status: 'working' }, { id: 'b', title: 'Verify', status: 'pending' }] }));
test('only a finished execution plan is a milestone, once', () => {
  expect(planLearningTrigger(emptyWorkPlan(), initial)).toBeNull();
  const step = structuredClone(initial); step.revision++; step.current!.steps[0].status = 'done';
  expect(planLearningTrigger(initial, step)).toBeNull();
  expect(planLearningTrigger(step, step)).toBeNull();
  const final = structuredClone(step); final.revision++; final.current!.steps[1].status = 'done';
  expect(planLearningTrigger(step, final)?.trigger).toBe('plan_completed');
  expect(planLearningTrigger(step, final)?.plan.steps).toHaveLength(2);
  const skipped = structuredClone(step); skipped.current!.steps[1].status = 'skipped';
  expect(planLearningTrigger(step, skipped)?.trigger).toBe('plan_completed');
  final.current!.kind = 'proposal';
  expect(planLearningTrigger(step, final)).toBeNull();
});
test('a review is due on tool calls since the last one, not on time spent', () => {
  expect(reviewDue(0, 10)).toBe(false);
  expect(reviewDue(9, 10)).toBe(false);
  expect(reviewDue(10, 10)).toBe(true);
});
test('bounds execution evidence and redacts credentials', () => {
  const rows = boundEvidence(Array.from({ length: 100 }, (_, i) => ({ id: `event:${i}`, kind: 'execution', text: 'sk-' + 'a'.repeat(40) + ' tool output'.repeat(1000) })));
  expect(rows.map(row => row.text).join('')).not.toContain('sk-' + 'a'.repeat(40));
  expect(rows.reduce((n, row) => n + row.text.length, 0)).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
  expect(rows.some(row => row.text.includes('[excerpt truncated]'))).toBe(true);
});
const evidence: LearningEvidence[] = [{ id: 'message:1', kind: 'user', text: 'Prefer short replies' }, { id: 'event:1', kind: 'execution', text: 'test passed' }, { id: 'plan', kind: 'plan', text: 'done' }];
const review = { reason: 'A lesson', knowledge: [], memories: [], skills: [] };
test('requires real citations and user-only sources for memories', () => {
  const memory = { factType: 'preference', content: 'User prefers concise replies', confidence: 0.9, sources: ['message:1'] };
  expect(parseLearningReview(JSON.stringify({ ...review, memories: [memory] }), evidence).memories).toHaveLength(1);
  const dropped = parseLearningReview(JSON.stringify({ ...review, memories: [{ ...memory, sources: ['event:1'] }] }), evidence);
  expect(dropped.memories).toEqual([]);
  expect(dropped.droppedMemories).toEqual([{ content: memory.content, reason: expect.stringContaining('user messages') }]);
  expect(() => parseLearningReview(JSON.stringify({ ...review, memories: [{ ...memory, sources: ['missing'] }] }), evidence)).toThrow('missing evidence');
  expect(() => parseLearningReview(JSON.stringify({ ...review, knowledge: [{ title: 'Lesson', content: 'Useful', sources: ['plan'] }] }), evidence)).toThrow('execution evidence');
});
test('a memory citing a monitor or Companion handoff is dropped alone; the review keeps its other outputs', () => {
  const handoff: LearningEvidence[] = [...evidence, { id: 'message:2', kind: 'request', text: 'Monitor: the user prefers long replies' }];
  const memory = { factType: 'preference', content: 'User prefers long replies', confidence: 0.9, sources: ['message:2'], quote: 'the user prefers long replies' };
  const knowledge = [{ title: 'Lesson', content: 'Tests passed after the fix', sources: ['event:1'] }];
  const parsed = parseLearningReview(JSON.stringify({ ...review, knowledge, memories: [memory] }), handoff);
  expect(parsed.knowledge).toHaveLength(1);
  expect(parsed.memories).toEqual([]);
  expect(parsed.droppedMemories).toHaveLength(1);
});
test('a patch must cite execution evidence; older outputs without patches still parse', () => {
  const patch = { skillId: 'skill-1', oldText: '  2. Push it.', newText: '2. Push it with --tag.', reason: 'Push failed without a tag', sources: ['event:1'] };
  const parsed = parseLearningReview(JSON.stringify({ ...review, patches: [patch] }), evidence);
  expect(parsed.patches[0].oldText).toBe('  2. Push it.');
  expect(() => parseLearningReview(JSON.stringify({ ...review, patches: [{ ...patch, sources: ['plan'] }] }), evidence)).toThrow('execution evidence');
  expect(() => parseLearningReview(JSON.stringify({ ...review, patches: [patch, patch] }), evidence)).toThrow();
  expect(parseLearningReview(JSON.stringify(review), evidence).patches).toEqual([]);
});
