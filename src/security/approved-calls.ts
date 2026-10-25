/**
 * Calls the user approved for a pipeline (#12/#20): the call a parked stage was
 * blocked on, and the gate commands (`verifyCommand`) a plan or stage approval
 * named. They live on the pipeline row (`metadata.approvedCalls`), so they
 * survive a restart and end with the run.
 *
 * A grant is never session-wide. It executes a call without asking only when
 * the caller is the stage worker it was granted to — same pipeline (owned by
 * the caller's user, session and workspace, still running or awaiting
 * approval), same stage, same attempt for a blocked-call grant, same
 * `hostServices` capability — and the call is the same tool and action with
 * the same arguments (`callFingerprint`). A different cwd, env, network or
 * useShell flag, different file contents, a child the stage spawned, the root
 * agent or another pipeline: all still ask. A DENY never reaches this check.
 */
import { createHash } from 'node:crypto';
import { pipelineRepository } from '@/db/repositories/pipeline-repository';
import { securityLogger } from '@/utils/logger';
import type { SpaceToolCall } from './space-tools';

export interface ApprovedCall {
  toolId: string;
  toolName: string;
  action: string;
  /** Every authorization-relevant argument, hashed (`callFingerprint`). */
  fingerprint: string;
  /** The stage the grant belongs to. */
  nodeKey: string;
  /** The stage attempt a blocked call was approved in; absent on a gate grant, which holds for each attempt of its stage. */
  attemptId?: string;
  /** The stage's host network + Docker socket opt-in the call was approved under. */
  hostServices: boolean;
}

/** Who a stage worker is, from the metadata the pipeline (never the model) put on its context. */
export interface StageScope { pipelineId: string; nodeKey: string; attemptId: string; hostServices: boolean }

export function stageScopeOf(metadata: Record<string, unknown> | null | undefined): StageScope | undefined {
  const { pipelineId, nodeKey, attemptId, hostServices } = metadata ?? {};
  if (typeof pipelineId !== 'string' || typeof nodeKey !== 'string' || typeof attemptId !== 'string' || !attemptId) return undefined;
  return { pipelineId, nodeKey, attemptId, hostServices: hostServices === true };
}

/** The argument that names what a call acts on, for the approval prompt. */
export function approvalSubject(args: Record<string, unknown> | undefined): string | undefined {
  for (const key of ['command', 'file_path', 'filePath', 'path']) {
    if (typeof args?.[key] === 'string' && args[key]) return args[key] as string;
  }
  return undefined;
}

/** Only known shell operations have cosmetic labels or execution time limits. */
function cosmeticArgument(toolId: string, toolName: string, key: string): boolean {
  if (toolId === 'cli-native:Bash' && toolName === 'Bash') return key === 'description' || key === 'timeout';
  return toolId === 'shell' && toolName === 'run' && key === 'timeout';
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function callFingerprint(toolId: string, action: string, toolName: string, args: Record<string, unknown>): string {
  const relevant = Object.fromEntries(Object.entries(args).filter(([key]) => !cosmeticArgument(toolId, toolName, key)));
  return createHash('sha256').update(JSON.stringify(canonical([toolId, action, toolName, relevant]))).digest('hex');
}

/**
 * The tool name a call is routed, and so matched, under. A permission row's
 * `toolName` is a label: the CLI bridge stores `CLI: Bash` for the approval
 * prompt (src/core/cli-permissions.ts), while the call itself routes with the
 * vendor tool's name, which is also its action. A grant built from the label
 * never matched the call it was approved for.
 */
export function routedToolName(toolId: string, action: string, label: string | undefined): string | undefined {
  return toolId.startsWith('cli-native:') ? action : label;
}

/** The grant for `call`, approved in this stage attempt. */
export function approvedCallOf(call: SpaceToolCall, scope: Omit<StageScope, 'pipelineId'>): ApprovedCall | undefined {
  if (!call.args || !call.toolName) return undefined;
  return { toolId: call.toolId, toolName: call.toolName, action: call.action, fingerprint: callFingerprint(call.toolId, call.action, call.toolName, call.args),
    nodeKey: scope.nodeKey, attemptId: scope.attemptId, hostServices: scope.hostServices };
}

/**
 * A gate command as both shells its stage can run it through: Octipus's shell
 * tool and the CLI's own Bash, each with the command as its only argument.
 * ponytail: exact text and default scope only; `npm test 2>&1`, a `cwd`, or
 * `useShell: false` spelled out still ask.
 */
export function gateCommandCalls(command: string, nodeKey: string, hostServices: boolean): ApprovedCall[] {
  return [['shell', 'execute', 'run'], ['cli-native:Bash', 'Bash', 'Bash']].map(([toolId, action, toolName]) =>
    ({ toolId, toolName, action, fingerprint: callFingerprint(toolId, action, toolName, { command }), nodeKey, hostServices }));
}

const grantKey = (c: ApprovedCall) => JSON.stringify([c.toolId, c.toolName, c.action, c.fingerprint, c.nodeKey, c.attemptId ?? null, c.hostServices]);

/** `metadata` with `calls` added once each. Grants in an older shape are dropped: they never match. */
export function withApprovedCalls(metadata: Record<string, unknown> | null | undefined, calls: ApprovedCall[]): Record<string, unknown> {
  const stored = (Array.isArray(metadata?.approvedCalls) ? metadata.approvedCalls as ApprovedCall[] : [])
    .filter(c => typeof c?.fingerprint === 'string' && typeof c.toolName === 'string' && typeof c.nodeKey === 'string');
  const seen = new Set(stored.map(grantKey));
  return { ...(metadata ?? {}), approvedCalls: [...stored, ...calls.filter(c => !seen.has(grantKey(c)) && seen.add(grantKey(c)))] };
}

export interface ApprovedCallCaller {
  userId: string;
  sessionId?: string;
  workspaceId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function isApprovedCall(caller: ApprovedCallCaller, call: SpaceToolCall): Promise<boolean> {
  const scope = stageScopeOf(caller.metadata);
  if (!scope || !caller.sessionId || !call.args || !call.toolName) return false;
  try {
    const pipeline = await pipelineRepository.findById(scope.pipelineId);
    if (!pipeline || pipeline.userId !== caller.userId || pipeline.sessionId !== caller.sessionId
      || (pipeline.workspaceId ?? null) !== (caller.workspaceId ?? null)
      || !['running', 'awaiting_approval'].includes(pipeline.status)) return false;
    const grants = (pipeline.metadata as { approvedCalls?: ApprovedCall[] } | null)?.approvedCalls;
    if (!Array.isArray(grants)) return false;
    const fingerprint = callFingerprint(call.toolId, call.action, call.toolName, call.args);
    return grants.some(g => g.toolId === call.toolId && g.toolName === call.toolName && g.action === call.action && g.fingerprint === fingerprint
      && (g.nodeKey === scope.nodeKey || g.nodeKey === '*' && (pipeline.metadata?.permissionProfile as { approvedBy?: string } | undefined)?.approvedBy === caller.userId) && (g.attemptId === undefined || g.attemptId === scope.attemptId)
      && g.hostServices === scope.hostServices);
  } catch (err) {
    // Not knowing means asking, never executing.
    securityLogger.warn({ err, pipelineId: scope.pipelineId }, 'Pipeline approval lookup failed; asking instead');
    return false;
  }
}

/**
 * May a call decided at level ASK still run, at the moment it executes? It may
 * when a person approved it just now (`approval:<id>`), or when it runs on a
 * pipeline grant that still holds: the pipeline is live and the grant still
 * names this exact call for this stage attempt.
 */
export async function askStillAuthorized(source: string, caller: ApprovedCallCaller, call: SpaceToolCall): Promise<boolean> {
  if (source.startsWith('approval:')) return true;
  if (source !== 'pipeline-approval') return false;
  if (await isApprovedCall(caller, call)) return true;
  const { profileAllows, runPermissionProfile } = await import('./pipeline-permissions');
  const run = await runPermissionProfile(caller);
  return !!run && profileAllows(run.profile, call);
}
