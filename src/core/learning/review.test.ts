import { expect, test } from 'vitest';
import { boundEvidence, boundExisting, existingChars, MAX_EVIDENCE_CHARS, MAX_EXISTING_CHARS, MAX_PATCH_TARGET_CHARS, MAX_PATCHABLE_SKILLS, mergePatchTargets, type LearningEvidence } from './evidence';
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
  // One patch too many is cut off; the review is kept.
  expect(parseLearningReview(JSON.stringify({ ...review, patches: [patch, patch] }), evidence).patches).toHaveLength(1);
  expect(parseLearningReview(JSON.stringify(review), evidence).patches).toEqual([]);
});

const skill = { name: 'repair-cache', description: 'Repair stale caches', content: 'Check, invalidate, verify', sources: ['event:1'] };
test('a skill without a signal defaults to procedure instead of failing the review', () => {
  expect(parseLearningReview(JSON.stringify({ ...review, skills: [skill] }), evidence).skills[0].signal).toBe('procedure');
  expect(parseLearningReview(JSON.stringify({ ...review, skills: [{ ...skill, signal: 'hunch' }] }), evidence).skills[0].signal).toBe('procedure');
  expect(parseLearningReview(JSON.stringify({ ...review, skills: [{ ...skill, signal: 'correction' }] }), evidence).skills[0].signal).toBe('correction');
});
test('extends survives only for a proposal that was offered', () => {
  const offered = 'proposal:11111111-1111-4111-8111-111111111111';
  const kept = parseLearningReview(JSON.stringify({ ...review, skills: [{ ...skill, extends: offered }] }), evidence, { offeredProposals: [offered] });
  expect(kept.skills[0].extends).toBe(offered);
  expect(kept.ignoredExtends).toEqual([]);
  // A bare id of an offered proposal is the same ref.
  const bare = parseLearningReview(JSON.stringify({ ...review, skills: [{ ...skill, extends: offered.slice('proposal:'.length) }] }), evidence, { offeredProposals: [offered] });
  expect(bare.skills[0].extends).toBe(offered);
  const other = 'proposal:22222222-2222-4222-8222-222222222222';
  const dropped = parseLearningReview(JSON.stringify({ ...review, skills: [{ ...skill, extends: other }] }), evidence, { offeredProposals: [offered] });
  expect(dropped.skills).toHaveLength(1);
  expect(dropped.skills[0].extends).toBeUndefined();
  expect(dropped.ignoredExtends).toEqual([other]);
  expect(parseLearningReview(JSON.stringify({ ...review, skills: [{ ...skill, extends: other }] }), evidence).skills[0].extends).toBeUndefined();
});
test('existing is bounded, nearest first, keeping proposals and skills in turn', () => {
  const item = (kind: string, i: number) => ({ ref: `${kind}:${i}`, name: `${kind}-${i}`, description: 'd'.repeat(400), excerpt: 'e'.repeat(600) });
  const big = { skills: Array.from({ length: 30 }, (_, i) => item('skill', i)), proposals: Array.from({ length: 10 }, (_, i) => item('proposal', i)),
    notes: Array.from({ length: 5 }, (_, i) => ({ ref: `note:${i}`, title: `note-${i}`, excerpt: 'n'.repeat(600) })) };
  const bounded = boundExisting(big);
  expect(existingChars(bounded)).toBeLessThanOrEqual(MAX_EXISTING_CHARS);
  expect(bounded.proposals[0].ref).toBe('proposal:0');
  expect(bounded.skills[0].ref).toBe('skill:0');
  expect(bounded.notes[0].ref).toBe('note:0');
  expect(Math.abs(bounded.proposals.length - bounded.skills.length)).toBeLessThanOrEqual(1);
  const small = { skills: [item('skill', 0)], proposals: [], notes: [] };
  expect(boundExisting(small)).toEqual(small);
});
test('patch targets: loaded first, then nearest, without repeats, within both caps', () => {
  const s = (id: string, size = 10) => ({ id, name: id, content: 'x'.repeat(size) });
  expect(mergePatchTargets([s('a')], [s('a'), s('b'), s('c')]).map(t => t.id)).toEqual(['a', 'b']);
  expect(mergePatchTargets([], [s('big', MAX_PATCH_TARGET_CHARS), s('b')]).map(t => t.id)).toEqual(['b']);
  expect(mergePatchTargets([s('a'), s('b'), s('c')], []).length).toBe(MAX_PATCHABLE_SKILLS);
});

const knowledge = { title: 'Pool size', content: 'The pool is capped at 10 because the proxy refuses more', sources: ['event:1'] };
test('a knowledge item defaults to kind fact, is at most 2, and keeps extends only for an offered note', () => {
  expect(parseLearningReview(JSON.stringify({ ...review, knowledge: [knowledge] }), evidence).knowledge[0].kind).toBe('fact');
  expect(parseLearningReview(JSON.stringify({ ...review, knowledge: [{ ...knowledge, kind: 'opinion' }] }), evidence).knowledge[0].kind).toBe('fact');
  expect(parseLearningReview(JSON.stringify({ ...review, knowledge: [{ ...knowledge, kind: 'decision' }] }), evidence).knowledge[0].kind).toBe('decision');
  expect(parseLearningReview(JSON.stringify({ ...review, knowledge: [knowledge, knowledge, knowledge] }), evidence).knowledge).toHaveLength(2);
  const offered = 'note:11111111-1111-4111-8111-111111111111';
  const kept = parseLearningReview(JSON.stringify({ ...review, knowledge: [{ ...knowledge, extends: offered.slice(5) }] }), evidence, { offeredNotes: [offered] });
  expect(kept.knowledge[0].extends).toBe(offered);
  const dropped = parseLearningReview(JSON.stringify({ ...review, knowledge: [{ ...knowledge, extends: 'note:other' }] }), evidence, { offeredNotes: [offered] });
  expect(dropped.knowledge[0].extends).toBeUndefined();
  expect(dropped.ignoredNoteExtends).toEqual(['note:other']);
});

test('one item too many is cut off, not a failed review', () => {
  const item = (n: number) => ({ title: `Lesson ${n}`, content: `Fact ${n} held after the fix`, sources: ['event:1'] });
  const parsed = parseLearningReview(JSON.stringify({ reason: 'Three lessons', knowledge: [item(1), item(2), item(3)], memories: [], skills: [] }),
    [{ id: 'event:1', kind: 'execution', text: 'ok' }]);
  expect(parsed.knowledge.map((k) => k.title)).toEqual(['Lesson 1', 'Lesson 2']);
});
