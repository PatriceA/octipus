/**
 * Read-only turns: a hook turn started by someone else's text may look, not act.
 *
 * A `spawn_agent` hook with `actionConfig.readOnly` runs its turn with a
 * fixed allowance instead of the session's tools: reads of files, git,
 * GitHub/GitLab/Atlassian and the knowledge base, handlers that declare
 * themselves read-only, and one way out, `send_to_user` to the hook's own
 * owner (the notify step). Everything else is refused before the permission
 * check: shell, file writes, web fetch and search (a URL carries data out),
 * MCP, delegation, posting, pushing. The design follows DeepSeek Harness's
 * proposed event-triggered automation (read-only event turns, notify as the
 * only output).
 *
 * The allowance is an allowlist, not a list of what to refuse: a tool added
 * later is refused in a read-only turn until it is named here.
 *
 * Scope is the session, for the length of the hook's turn: `withReadOnlyTurn`
 * marks it inside the session turn queue (`beforeStart`) and clears it when
 * the turn ends. Delegation is refused, so no child can outlive the mark; a
 * turn queued behind it (the user typing in that session) starts after the
 * mark is gone and runs normally.
 *
 * Enforced in both dispatch paths: the native ToolExecutor and the CLI
 * permission relay (core/cli-permissions.ts).
 */

import { isOwnerOnlyDelivery } from './flow-guard';

/** Sessions in a read-only turn, with how many such turns hold the mark. */
const active = new Map<string, number>();

export function beginReadOnlyTurn(sessionId: string): void {
  active.set(sessionId, (active.get(sessionId) ?? 0) + 1);
}

export function endReadOnlyTurn(sessionId: string): void {
  const n = (active.get(sessionId) ?? 0) - 1;
  if (n > 0) active.set(sessionId, n);
  else active.delete(sessionId);
}

export function isReadOnlyTurn(sessionId: string | undefined): boolean {
  return !!sessionId && active.has(sessionId);
}

/** Test seam. */
export function resetReadOnlyTurns(): void {
  active.clear();
}

/**
 * The notify step needs no approval in a read-only turn: `send_to_user` to the
 * turn's own user defaults to ASK, which an unattended hook run cannot answer,
 * and it reaches only that user's verified chats (the messaging tool refuses
 * anyone else from an unattended run). A stored DENY still wins: this lifts ASK
 * only, and only for that call.
 */
export function readOnlyNotifyAllowed(sessionId: string | undefined, userId: string, call: ReadOnlyCall): boolean {
  return isReadOnlyTurn(sessionId) && isOwnerOnlyDelivery(userId, call);
}

/** Tool ids whose `read` / `list` / `search` actions only read. */
const READ_TOOL_IDS = new Set(['filesystem', 'git', 'github', 'gitlab', 'atlassian', 'knowledge']);
const READ_ACTIONS = new Set(['read', 'list', 'search']);
/** Vendor CLI tools that only read (the same set the flow guard calls readers). */
const CLI_READERS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead', 'LS']);

export interface ReadOnlyCall {
  toolId: string;
  /** The permission action (`read`, `write`, …) or the vendor tool name. */
  action: string;
  args?: Record<string, unknown>;
  /** The handler declares `replaySafety: 'read_only'`. */
  readOnlyHandler?: boolean;
}

/**
 * Why this call is refused in a read-only turn, or undefined when it may run.
 * `userId` is the turn's user: `send_to_user` to them is the notify step.
 */
export function readOnlyRefusal(sessionId: string | undefined, userId: string, call: ReadOnlyCall): string | undefined {
  if (!isReadOnlyTurn(sessionId)) return undefined;
  // The notify step: the same check the flow guard exempts (security/flow-guard.ts).
  if (isOwnerOnlyDelivery(userId, call)) return undefined;
  if (call.toolId.startsWith('cli-native:')) {
    if (CLI_READERS.has(call.toolId.slice('cli-native:'.length))) return undefined;
  } else if (call.readOnlyHandler || (READ_TOOL_IDS.has(call.toolId) && READ_ACTIONS.has(call.action))) {
    return undefined;
  }
  return `read-only turn: ${call.toolId}.${call.action} is not available. This turn was started by an external event and may only read; `
    + 'to propose an action, tell the owner with send_to_user and stop.';
}
