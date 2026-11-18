import type { SessionContext } from '@/db/schema/sessions';
import { canServeText } from '@/models/topics';

/**
 * A model the Companion controller, its briefings and its maintenance sessions may run on:
 * an API or local text model with tools (their restricted toolbox cannot be enforced on a
 * native CLI), and not a reasoning-only variant. One rule for settings, maintenance and the
 * model selector.
 */
export function isCompanionControllerModel(model: { provider?: string | null; supportsTools?: boolean | null; modelId: string;
  topics?: readonly string[] | null; topicRoles?: Record<string, unknown> | null } | null | undefined): model is NonNullable<typeof model> {
  return !!model && model.provider !== 'cli' && !!model.supportsTools && canServeText(model) && !/reasoner|thinking/i.test(model.modelId);
}

/**
 * The model a Companion session is pinned to, if any. Project sessions route by the owner's
 * topic lanes like any session (including ones started before this rule, which stored a
 * model); only the supervisor and maintenance sessions run on the Companion model.
 */
export function companionBoundModel(ctx: Pick<SessionContext, 'companion' | 'companionMaintenance' | 'companionSupervisor'> | undefined): string | undefined {
  return (ctx?.companionMaintenance ? ctx.companion?.modelName : undefined) ?? ctx?.companionSupervisor?.modelName;
}
