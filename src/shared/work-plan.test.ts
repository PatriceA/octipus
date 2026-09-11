import { describe, expect, it } from 'vitest';
import { emptyWorkPlan, planUpdateSchema, reviseWorkPlan, formatWorkPlan } from './work-plan';
const input = () => planUpdateSchema.parse({ revision: 0, title: 'Review retries', goal: 'Handle timeouts', summary: 'Initial approach', steps: [{ id: 'inspect', title: 'Inspect code', status: 'pending' }] });
describe('visible work plans', () => {
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
    expect(() => reviseWorkPlan(state, { ...v, revision: 1, steps: [{ ...v.steps[0], status: 'pending' }] })).toThrow('Keep completed');
    expect(() => reviseWorkPlan(state, { ...v, revision: 1, steps: [{ ...v.steps[0], evidence: 'Tests passed' }] })).toThrow('Keep completed');
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
  expect(formatWorkPlan(state, true)).toBe('0/1 steps done');
});
