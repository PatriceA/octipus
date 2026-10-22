/**
 * Pipeline-stage pre-save validation.
 *
 * Pure function — lives in `src/` so the `npm test` suite can cover
 * it directly; the web UI imports it from `web/components/pipeline-graph.tsx`.
 *
 * Surfaces every problem in one pass so the UI can render a single
 * error block instead of the user fix-and-resubmit cycle.
 */

export interface PipelineStageInput {
  name: string;
  topic: string;
  requiresApproval?: boolean;
  stageType?: string;
  retryTargetStage?: number;
  maxRetries?: number;
  loopOverPlan?: boolean;
  producesPlan?: boolean;
  maxPlanItems?: number;
}

/**
 * One plan loop of a template, as `compileTemplateToGraph` will build it: a
 * maximal run of CONSECUTIVE `loopOverPlan` steps that repeats once per plan
 * item. Indices are 0-based step indices.
 */
export interface PlanLoopInfo {
  /** First and last step of the loop body (inclusive). */
  start: number;
  end: number;
  /** The step that writes the plan this loop iterates: the nearest earlier `producesPlan` step, if any. */
  plannerIndex: number | null;
  /** The loop's item cap (`maxPlanItems` of its first step declaring one); null ⇒ no cap. */
  maxItems: number | null;
  /** The plan is shown for sign-off once before the loop starts — the first body step's `requiresApproval`. */
  approvesPlan: boolean;
}

/** The plan loops a list of steps compiles to — the same grouping rule as the graph compiler. */
export function describePlanLoops(steps: readonly PipelineStageInput[]): PlanLoopInfo[] {
  const loops: PlanLoopInfo[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (!steps[i].loopOverPlan) continue;
    const start = i;
    while (i + 1 < steps.length && steps[i + 1].loopOverPlan) i++;
    let plannerIndex: number | null = null;
    for (let p = start - 1; p >= 0; p--) if (steps[p].producesPlan) { plannerIndex = p; break; }
    const capped = steps.slice(start, i + 1).find((st) => typeof st.maxPlanItems === 'number');
    loops.push({
      start,
      end: i,
      plannerIndex,
      maxItems: capped?.maxPlanItems ?? null,
      approvesPlan: !!steps[start].requiresApproval,
    });
  }
  return loops;
}

export function validatePipelineStages(steps: PipelineStageInput[]): string[] {
  const errors: string[] = [];
  if (steps.length === 0) errors.push('Pipeline must have at least one stage.');
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s.name || !s.name.trim()) {
      errors.push(`Stage ${i + 1}: name is required.`);
    }
    // A `human_input` stage runs no worker, so it binds no topic/model.
    if ((!s.topic || !s.topic.trim()) && s.stageType !== 'human_input') {
      errors.push(`Stage ${i + 1}: topic is required.`);
    }
    if (s.stageType === 'qa_validation') {
      const target = s.retryTargetStage;
      if (typeof target !== 'number') {
        errors.push(`Stage ${i + 1} (QA): retryTargetStage is required.`);
      } else if (target < 0 || target >= i) {
        // Must point to an EARLIER stage. >=i would be a forward
        // reference (forms a cycle once the QA fires).
        errors.push(
          `Stage ${i + 1} (QA): retry target ${target + 1} must be an earlier stage (1..${i}).`,
        );
      }
      if (typeof s.maxRetries === 'number' && s.maxRetries < 1) {
        errors.push(`Stage ${i + 1} (QA): maxRetries must be ≥ 1.`);
      }
    }
    if (s.maxPlanItems != null) {
      if (!s.loopOverPlan) {
        errors.push(`Stage ${i + 1}: a plan item limit only applies to a step that repeats for each plan item.`);
      } else if (!Number.isInteger(s.maxPlanItems) || s.maxPlanItems < 1) {
        errors.push(`Stage ${i + 1}: the plan item limit must be a whole number ≥ 1.`);
      }
    }
  }
  // A QA step inside a plan loop judges one item, so its retry must re-run a
  // step of the same loop. The compiler would otherwise re-target it to the
  // loop's first step without saying so — said here instead, at save time.
  for (const loop of describePlanLoops(steps)) {
    for (let i = loop.start; i <= loop.end; i++) {
      const target = steps[i].retryTargetStage;
      if (steps[i].stageType !== 'qa_validation' || typeof target !== 'number' || target >= i || target < 0) continue;
      if (target < loop.start) {
        errors.push(
          `Stage ${i + 1} (QA) repeats for each plan item, so its retry target must be a step of the same ` +
            `plan loop (stages ${loop.start + 1}–${loop.end + 1}), not stage ${target + 1}.`,
        );
      }
    }
  }
  return errors;
}

/**
 * Move a stage from one index to another and re-base every QA
 * `retryTargetStage` so retry pointers keep aiming at the same logical
 * stage post-reorder.
 *
 * Out-of-range indices, or `from === to`, return the input as-is. The
 * function does NOT validate the result — a reorder may push a QA's
 * retry target past it (forward reference); the consumer should run
 * `validatePipelineStages()` and surface those errors at save time.
 */
export function reorderStages<T extends PipelineStageInput>(
  steps: readonly T[],
  from: number,
  to: number,
): T[] {
  if (from === to) return [...steps];
  if (from < 0 || from >= steps.length || to < 0 || to >= steps.length) {
    return [...steps];
  }

  // Permutation: order[newIdx] = oldIdx
  const order = steps.map((_, i) => i);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);

  // oldIdx → newIdx lookup for retry-target rebasing
  const oldToNew = new Map<number, number>();
  order.forEach((oldIdx, newIdx) => oldToNew.set(oldIdx, newIdx));

  return order.map(oldIdx => {
    const s = steps[oldIdx];
    if (typeof s.retryTargetStage === 'number') {
      const remapped = oldToNew.get(s.retryTargetStage);
      return { ...s, retryTargetStage: remapped };
    }
    return { ...s };
  });
}
