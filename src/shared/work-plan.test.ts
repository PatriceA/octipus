import { describe, expect, it } from 'vitest';
import { emptyWorkPlan, planUpdateSchema, planPatchSchema, expandWorkPlanPatch, reviseWorkPlan, formatWorkPlan, workPlanStateSchema } from './work-plan';
const input = () => planUpdateSchema.parse({ revision: 0, title: 'Review retries', goal: 'Handle timeouts', summary: 'Initial approach', steps: [{ id: 'inspect', title: 'Inspect code', status: 'pending' }] });
describe('visible work plans', () => {
  it('patches one step while preserving omitted evidence, other steps and proposal kind', () => {
    const initial = input();
    initial.kind = 'proposal';
    initial.steps[0].evidence = 'Keep this evidence';
    initial.steps.push({ id: 'check', title: 'Check result', status: 'pending', evidence: '' });
    const state = reviseWorkPlan(emptyWorkPlan(), initial);
    const patch = planPatchSchema.parse({ revision: 1, summary: 'Clarify scope', stepUpdates: [{ id: 'inspect', title: 'Inspect retry handling' }] });
    const next = reviseWorkPlan(state, expandWorkPlanPatch(state, patch));
    expect(next.current!.kind).toBe('proposal');
    expect(next.current!.steps[0]).toEqual({ ...initial.steps[0], title: 'Inspect retry handling' });
    expect(next.current!.steps[1]).toEqual(initial.steps[1]);
    expect(state.current!.steps[0].title).toBe('Inspect code');
  });

  it('rejects stale, unknown, duplicate, mixed and completed-step patches', () => {
    const initial = input(); initial.steps[0].status = 'done';
    const state = reviseWorkPlan(emptyWorkPlan(), initial);
    const patch = { revision: 1, summary: 'Progress', stepUpdates: [{ id: 'inspect', status: 'working' }] };
    expect(() => expandWorkPlanPatch(state, planPatchSchema.parse({ ...patch, revision: 0 }))).toThrow('Plan changed');
    expect(() => expandWorkPlanPatch(state, planPatchSchema.parse({ ...patch, stepUpdates: [{ id: 'missing' }] }))).toThrow('Unknown plan step');
    expect(planPatchSchema.safeParse({ ...patch, stepUpdates: [patch.stepUpdates[0], patch.stepUpdates[0]] }).success).toBe(false);
    expect(planPatchSchema.safeParse({ ...patch, steps: initial.steps }).success).toBe(false);
    expect(() => reviseWorkPlan(state, expandWorkPlanPatch(state, planPatchSchema.parse(patch)))).toThrow('must stay in the plan as done');
    expect(() => expandWorkPlanPatch(emptyWorkPlan(), planPatchSchema.parse({ ...patch, revision: 0 }))).toThrow('Publish a full plan');
  });
  it('rejects duplicate IDs and malformed status', () => {
    const v = input();
    expect(planUpdateSchema.safeParse({ ...v, steps: [v.steps[0], v.steps[0]] }).success).toBe(false);
    expect(planUpdateSchema.safeParse({ ...v, steps: [{ ...v.steps[0], status: 'verified' }] }).success).toBe(false);
  });
  it('rejects stale revisions instead of discarding feedback', () => {
    const state = reviseWorkPlan(emptyWorkPlan(), input());
    expect(() => reviseWorkPlan(state, input())).toThrow('Plan changed');
  });
  it('preserves completed work and recorded evidence', () => {
    const v = input(); v.steps[0].status = 'done'; v.steps[0].evidence = 'Read retry.ts';
    const state = reviseWorkPlan(emptyWorkPlan(), v);
    expect(() => reviseWorkPlan(state, { ...v, revision: 1, steps: [{ ...v.steps[0], status: 'pending' }] })).toThrow('must stay in the plan as done');
    expect(() => reviseWorkPlan(state, { ...v, revision: 1, steps: [] })).toThrow('"inspect" is completed');
    // A paraphrased resend is accepted; the recorded title and evidence win.
    const next = reviseWorkPlan(state, { ...v, revision: 1, steps: [{ ...v.steps[0], title: 'Inspected the code', evidence: 'Tests passed' }] });
    expect(next.current!.steps[0]).toMatchObject({ title: 'Inspect code', evidence: 'Read retry.ts', status: 'done' });
  });
  it('appends explicit evidence patches to completed steps and deduplicates retries', () => {
    const initial = input(); initial.steps[0].status = 'done'; initial.steps[0].evidence = 'Tests passed';
    const state = reviseWorkPlan(emptyWorkPlan(), initial);
    const patch = (revision: number) => planPatchSchema.parse({ revision, summary: 'Review complete', stepUpdates: [{ id: 'inspect', evidence: 'Independent review passed' }] });
    const next = reviseWorkPlan(state, expandWorkPlanPatch(state, patch(1)));
    expect(next.current!.steps[0].evidence).toBe('Tests passed\n\nIndependent review passed');
    expect(next.current!.steps[0].status).toBe('done');
    expect(state.current!.steps[0].evidence).toBe('Tests passed');
    const retry = reviseWorkPlan(next, expandWorkPlanPatch(next, patch(2)));
    expect(retry.current!.steps[0].evidence).toBe(next.current!.steps[0].evidence);
  });

  it('requires explicit responses and keeps unresolved feedback on the current plan', () => {
    const state = reviseWorkPlan(emptyWorkPlan(), input());
    state.current!.feedback.push({ id: 'f', text: 'Keep API', status: 'pending', createdAt: new Date().toISOString() });
    expect(() => reviseWorkPlan(state, { ...input(), revision: 1, newPlan: true })).toThrow('Handle pending');
    const next = reviseWorkPlan(state, { ...input(), revision: 1, feedbackResponses: [{ id: 'f', status: 'applied', response: 'Kept API in scope' }] });
    expect(next.current!.feedback[0].status).toBe('applied');
    expect(state.current!.feedback[0].status).toBe('pending');
    const archived = reviseWorkPlan(next, { ...input(), revision: 2, newPlan: true });
    expect(archived.previous[0].id).toBe(next.current!.id);
    expect(archived.current!.id).not.toBe(next.current!.id);
  });
});

it('terminal plan projection exposes evidence and strips terminal controls', () => {
  const v = input(); v.title = '\x1b[2JReview'; v.steps[0].evidence = 'Tests not run';
  const state = reviseWorkPlan(emptyWorkPlan(), v);
  expect(formatWorkPlan(state)).toContain('Tests not run');
  expect(formatWorkPlan(state)).not.toContain('\x1b');
  expect(formatWorkPlan(state, true)).toBe('Execution ·  [2JReview · revision 1 · 0/1 steps done');
});

it('stores and renders the complete proposed plan', () => {
  const state = reviseWorkPlan(emptyWorkPlan(), planUpdateSchema.parse({
    ...input(),
    kind: 'proposal',
    details: '# Review retries\n\n## Validation\nRun focused tests.\x1b',
  }));
  expect(state.current).toMatchObject({ kind: 'proposal', details: expect.stringContaining('## Validation') });
  expect(formatWorkPlan(state, true)).toBe('Proposed · Review retries · revision 1 · 0/1 steps done');
  expect(formatWorkPlan(state)).toContain('# Review retries\n\n## Validation');
  expect(formatWorkPlan(state)).not.toContain('\x1b');
});

it('loads older stored plans as execution plans', () => {
  const state = reviseWorkPlan(emptyWorkPlan(), input());
  const stored = JSON.parse(JSON.stringify(state));
  delete stored.current.kind;
  expect(workPlanStateSchema.parse(stored).current!.kind).toBe('execution');
});
