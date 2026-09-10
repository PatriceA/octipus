/** Shared dispatch policy: delegation never turns ASK into authorization. */
import type { PermissionLevel } from '@/core/types';

export type ApprovalRoute =
  /** Run an explicitly allowed action. */
  | 'execute'
  /** Block and ask a human — only ever chosen when one can actually answer. */
  | 'ask_human'
  /** Refuse. The model is told, and must not retry. */
  | 'deny'
  | 'blocked';

export interface ApprovalContext {
  /** The stored permission for this action. */
  level: PermissionLevel;
  /** Agent role making the call. Used only for the denial message. */
  role?: string;
  /** The caller is the turn's ROOT agent. */
  root?: boolean;
  /** …and a person is actually waiting on it. Undefined uses the legacy root-only fallback. */
  attended?: boolean;
  toolId: string;
  /** The permission action, which is usually the tool name. */
  action: string;
  /**
   * Legacy actions to deny rather than report blocked when unattended.
   * Matched as `toolId` (whole container) or `toolId__action` / `toolId.action`.
   */
  unattendedDenyActions?: string[];
}

export interface ApprovalDecision {
  route: ApprovalRoute;
  /** Human-readable, and shown to the model on a denial. */
  reason?: string;
}

/** Attendance is inherited from the initiating session, including by children. */
export function canPromptHuman(caller: { role?: string; root?: boolean; attended?: boolean }): boolean {
  if (caller.attended !== undefined) return caller.attended;
  return caller.root === true;
}

/**
 * Surfaces that CANNOT put an approval prompt in front of a person.
 *
 * `attended` used to mean "not a hook and not a heartbeat", and the comment on
 * `canPromptHuman` asserted that the API path "does reach a person". It does
 * not: there is no `api` relay, so `umi.send('api', …)` throws and the prompt is
 * delivered nowhere. A REST caller's ASK therefore sat pending for its whole TTL
 * and then failed — five minutes of nothing, for a question nobody could have
 * been asked.
 *
 * Deliberately a DENYLIST, not an allowlist. Getting it wrong in this direction
 * costs a stall; getting it wrong the other way blocks an ASK on
 * a surface that could have shown the user a prompt. So a channel is treated as
 * attended unless it is known to have no way to ask — and a new client type
 * keeps the prompting behaviour by default.
 *
 * Known-unpromptable: the REST API (no relay), and the unattended triggers
 * (hook, heartbeat, cron) which by definition have nobody watching. Interactive
 * clients — `webchat` (its own approval control), `tui` (a pi-tui overlay),
 * `mobile`, `acp`, and the messaging adapters, which relay the prompt and read
 * the yes/no reply — all prompt.
 */
const UNPROMPTABLE_CHANNELS = new Set(['api', 'hook', 'heartbeat', 'cron', 'agent', 'qa-demo']);

/** Can an approval raised on this channel actually reach a person? */
export function channelCanPrompt(channel: string | undefined): boolean {
  if (!channel) return false;
  return !UNPROMPTABLE_CHANNELS.has(channel);
}

/** Does `pattern` name this tool action? */
/**
 * Is `toolId`/`action` named by one of `patterns`?
 *
 * Exported because `base-tool` needs the same answer to decide whether an
 * unattended call can skip the permission round-trip at all — two dispatch
 * paths disagreeing about what "listed" means is how the original bug got in.
 */
export function isListedAction(patterns: string[] | undefined, toolId: string, action: string): boolean {
  return (patterns ?? []).some((p) => matches(p, toolId, action));
}

function matches(pattern: string, toolId: string, action: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  return p === toolId || p === `${toolId}__${action}` || p === `${toolId}.${action}`;
}

/**
 * The decision. Pure — no DB, no config read, no agent — so the policy can be
 * tested exhaustively without booting anything.
 */
export function routeApproval(ctx: ApprovalContext): ApprovalDecision {
  if (ctx.level === 'DENY') {
    return { route: 'deny', reason: 'action is not allowed' };
  }
  if (ctx.level !== 'ASK') {
    return { route: 'execute' };
  }
  if (canPromptHuman(ctx)) {
    return { route: 'ask_human' };
  }
  const denied = (ctx.unattendedDenyActions ?? []).find((p) => matches(p, ctx.toolId, ctx.action));
  if (denied) {
    return {
      route: 'deny',
      reason:
        `"${denied}" requires human approval and this ${ctx.role} worker cannot ask for one ` +
        `(unattendedDenyActions). Report what you needed and stop.`,
    };
  }
  return {
    route: 'blocked',
    reason: 'Approval required, but this run has no approval channel. Configure a scoped permission before restarting the action.',
  };
}
