/**
 * Calls the user approved for a pipeline (#12/#20): the call a parked stage was
 * blocked on, and the gate commands (`verifyCommand`) a plan or stage approval
 * named. They live on the pipeline row (`metadata.approvedCalls`), so they
 * survive a restart and end with the run: while that pipeline is running or
 * awaiting approval, an identical call in its session (same tool, action and
 * command or path) executes without asking. Anything else still asks.
 */
import { pipelineRepository } from '@/db/repositories/pipeline-repository';
import { securityLogger } from '@/utils/logger';
import type { SpaceToolCall } from './space-tools';

export interface ApprovedCall { toolId: string; action: string; subject: string }

/** The argument that names what a call acts on; a call without one is never pre-approved. */
export function approvalSubject(args: Record<string, unknown> | undefined): string | undefined {
  for (const key of ['command', 'file_path', 'filePath', 'path']) {
    if (typeof args?.[key] === 'string' && args[key]) return args[key] as string;
  }
  return undefined;
}

export function approvedCallOf(call: SpaceToolCall): ApprovedCall | undefined {
  const subject = approvalSubject(call.args);
  return subject ? { toolId: call.toolId, action: call.action, subject } : undefined;
}

/**
 * A gate command as both shells a stage can run it through: Octipus's shell
 * tool and the CLI's own Bash. ponytail: exact command text only; `npm test
 * 2>&1` still asks.
 */
export function gateCommandCalls(command: string): ApprovedCall[] {
  return [{ toolId: 'shell', action: 'execute', subject: command }, { toolId: 'cli-native:Bash', action: 'Bash', subject: command }];
}

/** `metadata` with `calls` added once each. */
export function withApprovedCalls(metadata: Record<string, unknown> | null | undefined, calls: ApprovedCall[]): Record<string, unknown> {
  const stored = Array.isArray(metadata?.approvedCalls) ? metadata.approvedCalls as ApprovedCall[] : [];
  const key = (c: ApprovedCall) => JSON.stringify([c.toolId, c.action, c.subject]);
  const seen = new Set(stored.map(key));
  return { ...(metadata ?? {}), approvedCalls: [...stored, ...calls.filter(c => !seen.has(key(c)) && seen.add(key(c)))] };
}

export async function isApprovedCall(sessionId: string | undefined, call: SpaceToolCall): Promise<boolean> {
  const entry = approvedCallOf(call);
  if (!sessionId || !entry) return false;
  try {
    return await pipelineRepository.hasApprovedCall(sessionId, entry);
  } catch (err) {
    // Not knowing means asking, never executing.
    securityLogger.warn({ err, sessionId }, 'Pipeline approval lookup failed; asking instead');
    return false;
  }
}
