import { describe, expect, it } from 'vitest';
import { emptyWorkPlan, addPlanFeedback, planUpdateSchema, reviseWorkPlan, workPlanStateSchema } from '@/shared/work-plan';
import type { Pipeline, PlanItemRow } from '../schema/pipelines';
import { projectPipelinePlan } from './pipeline-work-plan';
const pipeline = { id: 'pipeline', title: 'Build feature', description: 'Deliver it', status: 'running', createdAt: new Date('2026-01-01') } as Pipeline;
const item = (id: string, status: PlanItemRow['status'] = 'pending') => ({ id, title: id, status, detail: 'Implement', result: null }) as PlanItemRow;

describe('pipeline work plan projection', () => {
  it('publishes actual pipeline items and follows failure and retry while preserving feedback', () => {
    let state = projectPipelinePlan(emptyWorkPlan(), pipeline, [item('one')]);
    expect(state.current).toMatchObject({ id: 'pipeline', steps: [{ id: 'one', status: 'pending' }] });
    state = addPlanFeedback(state, 'pipeline', state.revision, 'Check compatibility');
    state = projectPipelinePlan(state, pipeline, [item('one', 'failed')]);
    expect(state.current?.steps[0].status).toBe('blocked');
    state = projectPipelinePlan(state, pipeline, [item('one', 'running')]);
    expect(state.current?.steps[0].status).toBe('working');
    expect(state.current?.feedback[0].text).toBe('Check compatibility');
  });
  it('does not overwrite a coordinator-owned plan', () => {
    const state = projectPipelinePlan(emptyWorkPlan(), { ...pipeline, id: 'coordinator' }, [item('other')]);
    expect(projectPipelinePlan(state, pipeline, [item('one')])).toBe(state);
  });
  it('archives a completed pipeline plan when a newer pipeline takes over', () => {
    const old = { ...pipeline, status: 'completed' as const };
    const first = projectPipelinePlan(emptyWorkPlan(), old, [item('one', 'done')]);
    const newer = { ...pipeline, id: 'newer', createdAt: new Date('2026-01-02') };
    const next = projectPipelinePlan(first, newer, [item('two')], old);
    expect(next.current?.sourcePipelineId).toBe('newer');
    expect(next.current?.steps[0].id).toBe('two');
    expect(next.previous[0].steps[0]).toMatchObject({ id: 'one', status: 'done' });
    expect(projectPipelinePlan(next, old, [item('one', 'done')], { ...newer, status: 'completed' })).toBe(next);
  });
  it('does not take over an active pipeline or archive pending feedback', () => {
    const first = projectPipelinePlan(emptyWorkPlan(), pipeline, [item('one')]);
    const newer = { ...pipeline, id: 'newer', createdAt: new Date('2026-01-02') };
    expect(projectPipelinePlan(first, newer, [item('two')], pipeline)).toBe(first);
    const feedback = addPlanFeedback(first, pipeline.id, first.revision, 'Please check this');
    expect(projectPipelinePlan(feedback, newer, [item('two')], { ...pipeline, status: 'failed' })).toBe(feedback);
  });
  it('hands ownership to the coordinator on a manual revision', () => {
    const first = projectPipelinePlan(emptyWorkPlan(), pipeline, [item('one')]);
    expect(workPlanStateSchema.parse(first).current?.sourcePipelineId).toBe(pipeline.id);
    const edited = reviseWorkPlan(first, planUpdateSchema.parse({ revision: first.revision,
      title: 'Coordinator plan', goal: 'Include follow-up', summary: 'Added follow-up',
      steps: [...first.current!.steps, { id: 'follow-up', title: 'Release checks', status: 'pending', evidence: '' }],
    }));
    expect(edited.current?.sourcePipelineId).toBeUndefined();
    expect(projectPipelinePlan(edited, pipeline, [item('one', 'done')])).toBe(edited);
  });
  it('blocks an active item on pipeline failure and follows resume without changing execution rows', () => {
    const running = item('one', 'running');
    const failed = projectPipelinePlan(emptyWorkPlan(), { ...pipeline, status: 'failed', summary: 'QA worker exited' }, [running]);
    expect(failed.current?.steps[0]).toMatchObject({ status: 'blocked', evidence: 'QA worker exited' });
    expect(projectPipelinePlan(failed, pipeline, [running]).current?.steps[0].status).toBe('working');
    expect(running.status).toBe('running');
  });
  it('keeps large plans within the view limit and exposes overflow in details', () => {
    const state = projectPipelinePlan(emptyWorkPlan(), pipeline, Array.from({length: 25}, (_, i) => item(`item-${i}`)));
    expect(state.current?.steps).toHaveLength(20);
    expect(state.current?.steps[19].title).toContain('6 additional');
    expect(state.current?.details).toContain('item-24');
  });
});
