import { z } from 'zod';

export const planStepSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().trim().min(1).max(240),
  status: z.enum(['pending', 'working', 'done', 'blocked', 'skipped']),
  evidence: z.string().max(2000).default(''),
});
export const planUpdateSchema = z.object({
  revision: z.number().int().nonnegative(),
  newPlan: z.boolean().default(false),
  title: z.string().trim().min(1).max(240),
  goal: z.string().trim().min(1).max(2000),
  steps: z.array(planStepSchema).min(1).max(20),
  summary: z.string().trim().min(1).max(1000),
  feedbackResponses: z.array(z.object({
    id: z.string(),
    status: z.enum(['applied', 'needs_clarification']),
    response: z.string().trim().min(1).max(1000),
  })).max(50).default([]),
}).refine(v => new Set(v.steps.map(s => s.id)).size === v.steps.length, 'Step IDs must be unique');
export type PlanUpdate = z.infer<typeof planUpdateSchema>;
export interface PlanFeedback {
  id: string;
  text: string;
  createdAt: string;
  status: 'pending' | 'applied' | 'needs_clarification';
  response?: string;
}
export interface WorkPlan {
  id: string;
  revision: number;
  title: string;
  goal: string;
  steps: z.infer<typeof planStepSchema>[];
  updatedAt: string;
  feedback: PlanFeedback[];
  history: Array<{ revision: number; summary: string; at: string }>;
}
export interface WorkPlanState {
  revision: number;
  current: WorkPlan | null;
  previous: WorkPlan[];
}
const storedPlanSchema = z.object({
  id: z.string(), revision: z.number().int().nonnegative(), title: z.string(), goal: z.string(),
  steps: z.array(planStepSchema).max(20), updatedAt: z.string(),
  feedback: z.array(z.object({ id: z.string(), text: z.string(), createdAt: z.string(),
    status: z.enum(['pending', 'applied', 'needs_clarification']), response: z.string().optional() })).max(50),
  history: z.array(z.object({ revision: z.number(), summary: z.string(), at: z.string() })).max(100),
});
export const workPlanStateSchema = z.object({
  revision: z.number().int().nonnegative(), current: storedPlanSchema.nullable(), previous: z.array(storedPlanSchema).max(20),
});
export const workPlanViewSchema = workPlanStateSchema.extend({ planMode: z.boolean().optional() });

export const emptyWorkPlan = (): WorkPlanState => ({ revision: 0, current: null, previous: [] });

/** Apply an explicit agent revision, preserving completed work and feedback. */
export function reviseWorkPlan(state: WorkPlanState, input: PlanUpdate): WorkPlanState {
  if (input.revision !== state.revision) throw new Error('Plan changed. Read the current plan and retry.');
  const old = input.newPlan ? null : state.current;
  if (input.newPlan && state.current?.feedback.some(f => f.status === 'pending')) {
    throw new Error('Handle pending feedback before starting a new plan.');
  }
  for (const step of old?.steps ?? []) {
    if (step.status === 'done' && !input.steps.some(s => s.id === step.id && s.title === step.title && s.status === 'done' && s.evidence === step.evidence)) {
      throw new Error('Keep completed steps and their evidence. Add a follow-up step for further work.');
    }
  }
  const feedback = (old?.feedback ?? []).map(f => ({ ...f }));
  for (const reply of input.feedbackResponses) {
    const item = feedback.find(f => f.id === reply.id);
    if (!item || item.status !== 'pending') throw new Error('Feedback is missing or already handled.');
    Object.assign(item, { status: reply.status, response: reply.response });
  }
  const revision = state.revision + 1;
  const at = new Date().toISOString();
  return {
    revision,
    previous: input.newPlan && state.current ? [...state.previous, state.current].slice(-20) : state.previous,
    current: {
      id: old?.id ?? crypto.randomUUID(), revision, title: input.title, goal: input.goal,
      steps: input.steps, updatedAt: at, feedback,
      history: [...(old?.history ?? []), { revision, summary: input.summary, at }].slice(-100),
    },
  };
}

/** Record user feedback without treating receipt as acceptance by the agent. */
export function addPlanFeedback(state: WorkPlanState, planId: string, revision: number, text: string): WorkPlanState {
  if (!state.current || state.current.id !== planId || state.revision !== revision) throw new Error('Plan changed. Refresh and try again.');
  if (!text.trim() || text.trim().length > 2000) throw new Error('Feedback must contain 1–2000 characters.');
  if (state.current.feedback.length >= 50) throw new Error('This plan has reached its feedback limit.');
  return { ...state, revision: state.revision + 1, current: {
    ...state.current, revision: state.revision + 1,
    feedback: [...state.current.feedback, { id: crypto.randomUUID(), text: text.trim(), createdAt: new Date().toISOString(), status: 'pending' }],
  } };
}

/** Plain text projection used by terminal clients; never exposes ANSI controls. */
export function formatWorkPlan(state: WorkPlanState, compact = false): string {
  const plan = state.current;
  if (!plan) return 'No plan published yet.';
  const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  const done = plan.steps.filter(s => s.status === 'done').length;
  const current = plan.steps.find(s => s.status === 'working' || s.status === 'blocked');
  const summary = `${done}/${plan.steps.length} steps done${current ? ` · ${current.status}: ${clean(current.title)}` : ''}`;
  if (compact) return summary;
  const lines = [`${clean(plan.title)} · revision ${state.revision}`, clean(plan.goal), summary, ''];
  for (const step of plan.steps) {
    const mark = step.status === 'done' ? '[x]' : step.status === 'working' ? '[>]' : step.status === 'blocked' ? '[!]' : step.status === 'skipped' ? '[-]' : '[ ]';
    lines.push(`${mark} ${clean(step.title)} (${step.status})`, `    ${clean(step.evidence) || 'No evidence or checks recorded yet.'}`);
  }
  for (const f of plan.feedback) lines.push('', `Feedback (${f.status}): ${clean(f.text)}`, ...(f.response ? [clean(f.response)] : []));
  lines.push('', 'Steps report work progress, not independent verification.', '/plan-feedback <change> to give feedback. /plan on to explore before implementation.');
  return lines.join('\n');
}
