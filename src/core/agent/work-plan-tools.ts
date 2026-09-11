import type { ToolHandler } from '@/core/agent-base';
import { workPlanRepository } from '@/db/repositories/work-plan-repository';
import { planUpdateSchema, reviseWorkPlan } from '@/shared/work-plan';

/** Root-owned plans are visible in the conversation and survive reloads. */
export function createWorkPlanTools(): ToolHandler[] {
  return [{
    name: 'get_work_plan',
    description: 'Read the visible session plan, revision, and user feedback before revising it.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, context) => workPlanRepository.read(context.sessionId, context.userId),
  }, {
    name: 'update_work_plan',
    description: 'Publish and track a short user-visible plan for substantial work. Read the current revision first. Update steps at meaningful milestones and handle pending user feedback explicitly. Done means work completed, not independently verified: describe actual checks in evidence. Use newPlan for a new request; preserve completed steps when revising existing work. This does not approve actions or leave plan mode.',
    parameters: {
      type: 'object',
      properties: {
        revision: { type: 'integer', description: 'Current state revision from get_work_plan.' },
        newPlan: { type: 'boolean', description: 'Start a different request, archiving the previous plan.' },
        title: { type: 'string' }, goal: { type: 'string' }, summary: { type: 'string', description: 'What changed in this revision and why.' },
        steps: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'string' }, title: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'working', 'done', 'blocked', 'skipped'] },
          evidence: { type: 'string', description: 'Observed outcome, checks, sources or file paths; say when checks have not run.' },
        }, required: ['id', 'title', 'status', 'evidence'] } },
        feedbackResponses: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'string' }, status: { type: 'string', enum: ['applied', 'needs_clarification'] }, response: { type: 'string' },
        }, required: ['id', 'status', 'response'] } },
      },
      required: ['revision', 'title', 'goal', 'steps', 'summary'],
    },
    execute: async (args, context) => {
      const input = planUpdateSchema.parse(args);
      const current = await workPlanRepository.read(context.sessionId, context.userId);
      const next = reviseWorkPlan(current, input);
      await workPlanRepository.save(context.sessionId, context.userId, input.revision, next);
      return next;
    },
  }];
}
