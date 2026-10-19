import type { Pipeline, PlanItemRow } from '../schema/pipelines';
import { planUpdateSchema, reviseWorkPlan, type WorkPlanState } from '@/shared/work-plan';

/** Mirror pipeline progress only while this pipeline owns the visible plan. */
export function projectPipelinePlan(state: WorkPlanState, pipeline: Pipeline, items: PlanItemRow[], previousPipeline?: Pipeline | null): WorkPlanState {
  const current = state.current;
  const replacing = !!current && current.sourcePipelineId !== pipeline.id;
  const linked = !!current && !current.sourcePipelineId && pipeline.metadata?.workPlanId === current.id;
  if (replacing && !linked && (!current.sourcePipelineId || previousPipeline?.id !== current.sourcePipelineId
    || !['completed', 'failed'].includes(previousPipeline.status)
    || pipeline.createdAt <= previousPipeline.createdAt
    || current.feedback.some(feedback => feedback.status === 'pending'))) return state;
  if (!items.length && replacing) return state;
  if (!items.length) return state.current
    ? { revision: state.revision + 1, current: null, previous: [...state.previous, state.current].slice(-20) }
    : state;
  const status = (item: PlanItemRow) => item.status === 'running' ? (['failed', 'paused', 'stopped'].includes(pipeline.status) ? 'blocked' : 'working') : item.status === 'failed' ? 'blocked' : item.status;
  // A linked or already-owned plan is updated in place: its id, title, goal and
  // step ids stay what the coordinator published (#14). Only a plan the
  // pipeline starts itself is named after the pipeline.
  const inPlace = !!current && (linked || !replacing);
  const used = new Set<string>();
  const stepId = (item: PlanItemRow) => {
    const id = current?.steps.find(step => step.title === item.title.slice(0, 240) && !used.has(step.id))?.id ?? item.id;
    used.add(id);
    return id;
  };
  const steps = items.slice(0, items.length > 20 ? 19 : 20).map(item => ({
    id: stepId(item), title: item.title.slice(0, 240), status: status(item), evidence: (['failed', 'paused', 'stopped'].includes(pipeline.status) && item.status === 'running' ? pipeline.summary || 'Pipeline failed before this item finished.' : item.result ?? '').slice(0, 2000),
  }));
  if (items.length > 20) {
    const rest = items.slice(19);
    steps.push({ id: 'remaining-items', title: `${rest.length} additional pipeline items (see details)`,
      status: rest.some(i => status(i) === 'blocked') ? 'blocked' : rest.some(i => i.status === 'running') ? 'working'
        : rest.every(i => i.status === 'done' || i.status === 'skipped') ? 'done' : 'pending',
      evidence: `${rest.filter(i => i.status === 'done').length} done; ${rest.filter(i => i.status === 'skipped').length} skipped.`,
    });
  }
  const input = planUpdateSchema.parse({
    revision: state.revision, newPlan: !inPlace,
    title: inPlace ? current!.title : pipeline.title.slice(0, 240),
    goal: inPlace ? current!.goal : (pipeline.description || pipeline.title).split('\n')[0].slice(0, 300),
    steps, summary: 'Updated from pipeline execution.',
    details: items.map(item => `- [${item.status}] ${item.title}\n${item.detail ?? ''}`).join('\n').slice(0, 50000),
  });
  // Pipeline rows are authoritative, including retries and human edits. Preserve
  // feedback/history, but do not apply the model-authored completed-step guard.
  const next = reviseWorkPlan(inPlace ? { ...state, current: { ...current!, steps: [] } } : state, input);
  if (!inPlace) next.current!.id = pipeline.id;
  next.current!.sourcePipelineId = pipeline.id;
  return next;
}
