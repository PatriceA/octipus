import { describe, expect, it } from 'vitest';
import { emptyWorkPlan, planUpdateSchema, reviseWorkPlan, addPlanFeedback } from '@/shared/work-plan';
import { formatWorkPlanContext } from './work-plan-context';

describe('work plan model context', () => {
  it('preserves applied feedback after the pending queue is empty', () => {
    const input = planUpdateSchema.parse({ revision: 0, title: 'Check sample', goal: 'Verify labels and total', summary: 'Initial plan', steps: [{ id: 'labels', title: 'Check labels', status: 'pending' }] });
    const initial = reviseWorkPlan(emptyWorkPlan(), input);
    const received = addPlanFeedback(initial, initial.current!.id, 1, 'Check that labels are unique');
    const feedbackId = received.current!.feedback[0].id;
    const applied = reviseWorkPlan(received, { ...input, revision: 2, feedbackResponses: [{ id: feedbackId, status: 'applied', response: 'Added uniqueness check' }] });
    const completed = reviseWorkPlan(applied, { ...input, revision: 3, steps: [{ ...input.steps[0], status: 'done', evidence: 'A, B, C are unique' }] });
    const context = formatWorkPlanContext(completed)!;
    const payload = JSON.parse(context.slice(context.indexOf('\n') + 1));
    expect(payload.pendingFeedbackCount).toBe(0);
    expect(payload.feedback).toEqual([expect.objectContaining({ id: feedbackId, status: 'applied', text: 'Check that labels are unique', response: 'Added uniqueness check' })]);
    expect(context).toContain('No pending feedback means nothing is waiting');
    expect(completed.current!.feedback).toHaveLength(1);
  });

  it('keeps pending feedback actionable and distinguishes a session with no plan', () => {
    expect(formatWorkPlanContext(emptyWorkPlan())).toBeNull();
    const initial = reviseWorkPlan(emptyWorkPlan(), planUpdateSchema.parse({ revision: 0, title: 'Check', goal: 'Review', summary: 'Initial', steps: [{ id: 'read', title: 'Read', status: 'pending' }] }));
    const state = addPlanFeedback(initial, initial.current!.id, 1, 'Include sources');
    expect(formatWorkPlanContext(state)).toContain('"pendingFeedbackCount":1');
    expect(formatWorkPlanContext(state)).toContain('Include sources');
  });

  it('keeps a durable proposal pending on later turns without inlining its full artifact', () => {
    const initial = reviseWorkPlan(emptyWorkPlan(), planUpdateSchema.parse({
      revision: 0,
      kind: 'proposal',
      title: 'Mobile architecture',
      goal: 'Implement multiple backends',
      details: '# Full plan\n\nA deliberately durable specification.',
      summary: 'Published proposal',
      steps: [{ id: 'storage', title: 'Implement storage', status: 'pending' }],
    }));
    const context = formatWorkPlanContext(initial)!;
    expect(context).toContain('This is a proposal');
    expect(context).toContain('remain pending until the user separately asks to implement it');
    expect(context).toContain('"kind":"proposal"');
    expect(context).toContain('"detailsStored":true');
    expect(context).not.toContain('deliberately durable specification');
  });
});
