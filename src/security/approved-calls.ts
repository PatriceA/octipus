/**
 * Calls a user approved for a parked pipeline stage (#12/#20). The worker that
 * asked has already stopped, so the stage re-runs; its identical call — same
 * session, tool, action and command (or path) — then executes without asking
 * again. Anything else still asks.
 *
 * ponytail: in-memory with a TTL, so a restart forgets them and the re-run asks
 * again; persist next to permission rows if that ever matters.
 */
import type { SpaceToolCall } from './space-tools';

const TTL_MS = 2 * 60 * 60_000;
const approved = new Map<string, number>();

/** The argument that names what a call acts on; a call without one is never pre-approved. */
export function approvalSubject(args: Record<string, unknown> | undefined): string | undefined {
  for (const key of ['command', 'file_path', 'filePath', 'path']) {
    if (typeof args?.[key] === 'string' && args[key]) return args[key] as string;
  }
  return undefined;
}

function keyOf(sessionId: string, toolId: string, action: string, subject: string): string {
  return JSON.stringify([sessionId, toolId, action, subject]);
}

export function rememberApprovedCall(sessionId: string, call: SpaceToolCall): boolean {
  const subject = approvalSubject(call.args);
  if (!subject) return false;
  approved.set(keyOf(sessionId, call.toolId, call.action, subject), Date.now() + TTL_MS);
  return true;
}

export function isApprovedCall(sessionId: string | undefined, call: SpaceToolCall): boolean {
  const subject = approvalSubject(call.args);
  if (!sessionId || !subject) return false;
  const key = keyOf(sessionId, call.toolId, call.action, subject);
  const expires = approved.get(key);
  if (expires === undefined) return false;
  if (expires < Date.now()) { approved.delete(key); return false; }
  return true;
}
