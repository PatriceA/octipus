/**
 * Pipeline-stage pre-save validation.
 *
 * Pure function — lives in `src/` so the `bun test` suite can cover
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
