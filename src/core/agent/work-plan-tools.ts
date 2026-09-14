import type { ToolHandler } from '@/core/agent-base';
import { sessionRepository } from '@/db/repositories/session-repository';
import { workPlanRepository } from '@/db/repositories/work-plan-repository';
import { planUpdateSchema, reviseWorkPlan } from '@/shared/work-plan';

async function sessionIsInPlanMode(sessionId: string, userId: string): Promise<boolean> {
  const session = await sessionRepository.findById(sessionId);
  if (!session || session.userId !== userId) throw new Error('Session not found');
  return (session.context as Record<string, unknown> | null)?.planMode === true;
}

/** Persist the complete proposal supplied to exit_plan_mode. */
export async function submitWorkPlan(
  sessionId: string,
  userId: string,
  details: string,
): Promise<{ planId: string; revision: number }> {
  if (!(await sessionIsInPlanMode(sessionId, userId))) {
    throw new Error('Plan mode is not on for this session.');
  }
  const state = await workPlanRepository.read(sessionId, userId);
  const current = state.current;
  if (!current || current.kind !== 'proposal') {
    throw new Error(
      'Publish the proposed implementation steps with update_work_plan before submitting the detailed plan.',
    );
  }
  if (current.steps.some((step) => step.status !== 'pending')) {
    throw new Error('A proposed implementation plan must contain only pending steps.');
  }
  if (current.feedback.some((feedback) => feedback.status === 'pending')) {
    throw new Error('Address pending plan feedback before submitting the revised plan.');
  }
  const next = reviseWorkPlan(state, planUpdateSchema.parse({
    revision: state.revision,
    kind: 'proposal',
    title: current.title,
    goal: current.goal,
    details,
    steps: current.steps,
    summary: 'Submitted the detailed implementation plan for review.',
    feedbackResponses: [],
  }));
  await workPlanRepository.save(sessionId, userId, state.revision, next);
  return { planId: next.current!.id, revision: next.revision };
}

/** Root-owned plans are visible in the conversation and survive reloads. */
export function createWorkPlanTools(): ToolHandler[] {
  return [{
    name: 'get_work_plan',
    description: 'Read the visible session plan, revision, and user feedback before revising it.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, context) => workPlanRepository.read(context.sessionId, context.userId),
  }, {
    name: 'update_work_plan',
    description: 'Publish and track a user-visible work plan. Read the current revision first. Use kind=proposal when the user asks you to make, write, or revise a plan without implementing it, as well as whenever plan mode is on. A proposal contains the actual FUTURE IMPLEMENTATION steps, all pending, plus the complete markdown artifact in details. Exploring, designing, and writing the proposal are planning notes, not checklist steps. Use kind=execution when tracking work that is really being performed; done means implementation was completed, not that planning or research was completed and not that it was independently verified. Update execution steps at meaningful milestones and handle pending user feedback explicitly. Use newPlan for a new request; preserve completed steps when revising existing work. This does not approve actions or leave plan mode. exit_plan_mode replaces details with the final submitted markdown.',
    parameters: {
      type: 'object',
      properties: {
        revision: { type: 'integer', description: 'Current state revision from get_work_plan.' },
        newPlan: { type: 'boolean', description: 'Start a different request, archiving the previous plan.' },
        kind: {
          type: 'string',
          enum: ['execution', 'proposal'],
          description: 'proposal for a plan-only deliverable; execution only for work currently being performed.',
        },
        title: { type: 'string' }, goal: { type: 'string' }, summary: { type: 'string', description: 'What changed in this revision and why.' },
        details: {
          type: 'string',
          description: 'Complete markdown plan artifact. Required in practice for a proposal; omit for routine execution progress.',
        },
        steps: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'string' }, title: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'working', 'done', 'blocked', 'skipped'] },
          evidence: { type: 'string', description: 'Observed outcome, checks, sources or file paths; say when checks have not run.' },
        }, required: ['id', 'title', 'status', 'evidence'] } },
        feedbackResponses: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'string' }, status: { type: 'string', enum: ['applied', 'needs_clarification'] }, response: { type: 'string' },
        }, required: ['id', 'status', 'response'] } },
      },
      required: ['revision', 'kind', 'title', 'goal', 'steps', 'summary'],
    },
    execute: async (args, context) => {
      const input = planUpdateSchema.parse(args);
      const planMode = await sessionIsInPlanMode(context.sessionId, context.userId);
      const kind = planMode ? 'proposal' : input.kind;
      if (kind === 'proposal' && input.steps.some((step) => step.status !== 'pending')) {
        throw new Error(
          'A proposal must publish the future implementation steps with pending status. ' +
          'Do not mark planning, research, design, or writing the proposal as completed work.',
        );
      }
      if (kind === 'proposal' && !planMode && !input.details) {
        throw new Error('A plan-only proposal must include the complete markdown artifact in details.');
      }
      const current = await workPlanRepository.read(context.sessionId, context.userId);
      const next = reviseWorkPlan(current, {
        ...input,
        kind,
      });
      await workPlanRepository.save(context.sessionId, context.userId, input.revision, next);
      return next;
    },
  }];
}
