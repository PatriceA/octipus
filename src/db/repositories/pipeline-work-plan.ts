import type { Pipeline, PlanItemRow } from '../schema/pipelines';
import { planUpdateSchema, reviseWorkPlan, type WorkPlanState } from '@/shared/work-plan';

/** Mirror pipeline progress only while this pipeline owns the visible plan. */
export function projectPipelinePlan(state: WorkPlanState, pipeline: Pipeline, items: PlanItemRow[], previousPipeline?: Pipeline | null): WorkPlanState {
  const current = state.current;
  const replacing = !!current && current.sourcePipelineId !== pipeline.id;
  if (replacing && (!current.sourcePipelineId || previousPipeline?.id !== current.sourcePipelineId
    || !['completed', 'failed'].includes(previousPipeline.status)
    || pipeline.createdAt <= previousPipeline.createdAt
    || current.feedback.some(feedback => feedback.status === 'pending'))) return state;
  if (!items.length && replacing) return state;
  if (!items.length) return state.current
    ? { revision: state.revision + 1, current: null, previous: [...state.previous, state.current].slice(-20) }
    : state;
  const status = (item: PlanItemRow) => item.status === 'running' ? (pipeline.status === 'failed' ? 'blocked' : 'working') : item.status === 'failed' ? 'blocked' : item.status;
  const steps = items.slice(0, items.length > 20 ? 19 : 20).map(item => ({
    id: item.id, title: item.title.slice(0, 240), status: status(item), evidence: (pipeline.status === 'failed' && item.status === 'running' ? pipeline.summary || 'Pipeline failed before this item finished.' : item.result ?? '').slice(0, 2000),
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
    revision: state.revision, newPlan: replacing, title: pipeline.title.slice(0, 240), goal: (pipeline.description || pipeline.title).slice(0, 2000),
    steps, summary: 'Updated from pipeline execution.',
    details: items.map(item => `- [${item.status}] ${item.title}\n${item.detail ?? ''}`).join('\n').slice(0, 50000),
  });
  // Pipeline rows are authoritative, including retries and human edits. Preserve
  // feedback/history, but do not apply the model-authored completed-step guard.
  const next = reviseWorkPlan({ ...state, current: state.current && !replacing ? { ...state.current, steps: [] } : state.current }, input);
  next.current!.id = pipeline.id;
  next.current!.sourcePipelineId = pipeline.id;
  return next;
}
