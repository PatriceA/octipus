/**
 * Where an approval decision is made (roadmap wave 3, deterministic policy).
 *
 * `PermissionManager` answers what the STORED permission for a tool action is
 * (ALLOW / ASK / DENY). It does not answer the question the runtime actually
 * has to answer, which is what to DO with an ASK when the caller may not be
 * able to reach a human. That answer was hardcoded in two places —
 * `tool-executor.ts` (the agent loop) and `base-tool.ts` (the tool's own
 * middleware) — as "any role that is not the orchestrator auto-approves",
 * with a comment in each asking the other to be kept in sync. Two copies of a
 * security decision is one copy too many; this is the one.
 *
 * The rule the copies encoded is preserved exactly: an autonomous worker cannot
 * prompt anyone, so blocking on approval would hang it forever, and hanging is
 * not safer than proceeding — it is the same outcome with the budget still
 * running. What the copies could not express, and this can, is the exception:
 * `unattendedDenyActions` names the actions that must be REFUSED rather than
 * silently auto-approved when nobody is watching. Empty by default, because a
 * pipeline stage legitimately does almost anything inside its workspace and a
 * list invented here would break working runs; it exists so an operator can
 * state their own limit in one place instead of patching two.
 */

import type { PermissionLevel } from '@/core/types';

export type ApprovalRoute =
  /** Run it. Either allowed outright, or an ASK nobody can be asked about. */
  | 'execute'
  /** Block and ask a human — only ever chosen when one can actually answer. */
  | 'ask_human'
  /** Refuse. The model is told, and must not retry. */
  | 'deny';

export interface ApprovalContext {
  /** The stored permission for this action. */
  level: PermissionLevel;
  /** Agent role making the call. `orchestrator` is the one that talks to a human. */
  role?: string;
  toolId: string;
  /** The permission action, which is usually the tool name. */
  action: string;
  /**
   * Actions to refuse rather than auto-approve when the caller is unattended.
   * Matched as `toolId` (whole container) or `toolId__action` / `toolId.action`.
   */
  unattendedDenyActions?: string[];
}

export interface ApprovalDecision {
  route: ApprovalRoute;
  /** Human-readable, and shown to the model on a denial. */
  reason?: string;
  /** True when an ASK was resolved without a human — the counter the loop tracks. */
  autoApproved?: boolean;
}

/**
 * Can this caller reach a person? Only the orchestrator can: every other role
 * is a worker the orchestrator spawned, and its approval request would be
 * relayed by nobody.
 *
 * A missing role is the interactive/direct path (chat, API, CLI), which does
 * reach a person — the same reading both call sites had.
 */
export function canPromptHuman(role: string | undefined): boolean {
  return !role || role === 'orchestrator';
}

/** Does `pattern` name this tool action? */
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
  if (canPromptHuman(ctx.role)) {
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
  return { route: 'execute', autoApproved: true };
}
