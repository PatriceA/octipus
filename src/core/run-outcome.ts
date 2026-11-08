/**
 * A run's outcome for the run view (docs/MISSION-CONTROL.md, "Outcome and
 * evidence"): how it ended, the files its tools recorded writing, the files
 * its answer says it saved — confirmed only by a recorded write — and the
 * verification checks that judged it.
 *
 * Callers prove the run is the principal's (scoped repository) before calling.
 */
import { agentEventRepository } from '@/db/repositories/agent-event-repository';
import { verificationEvidenceRepository } from '@/db/repositories/verification-evidence-repository';
import type { AgentRecord } from '@/db/schema/agents';
import type { VerificationEvidenceRecord } from '@/db/schema/verification-evidence';
import { readAgentCompletionReason } from '@/shared/agent-completion';
import type { MissionRun, RunOutcome } from '@/shared/agent-origin';

export const ANSWER_LIMIT = 4_000;
const FILE_EXT = String.raw`[A-Za-z0-9][\w.\-/~]*\.[A-Za-z][A-Za-z0-9]{0,7}`;
// "saved to `notes.md`", "wrote report.pdf", "written to /workspace/out/a.csv" …, within one sentence.
const CLAIM_PATTERNS = [
  new RegExp(String.raw`\b(?:saved|wrote|written|created|exported|generated|stored)\b(?:[^\n\`.!?]|\.(?=\S)){0,40}?\`(${FILE_EXT})\``, 'gi'),
  new RegExp(String.raw`\b(?:saved|wrote|written|created|exported|generated|stored)\b(?:\s+(?:it|this|the\s+\w+|a\s+\w+))?\s+(?:(?:to|as|at|in|into)\s+)?(${FILE_EXT})(?=[\s.,;:)!?]|$)`, 'gi'),
];

const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p;

/** File paths the answer says were saved. Conservative: only after a save verb. */
export function claimedPaths(answer: string): string[] {
  const out = new Set<string>();
  for (const pattern of CLAIM_PATTERNS) {
    for (const m of answer.matchAll(pattern)) {
      const path = m[1].replace(/[.,;:]+$/, '');
      if (!/^https?:/i.test(path)) out.add(path);
    }
  }
  return [...out];
}

/**
 * A claim is confirmed by a recorded write of the same file. `write_file`
 * relocates a path into the session's output folder, so the written path may
 * be longer than the claimed one: the same path, a path ending in it, or the
 * same file name count.
 */
export function confirmClaims(claims: string[], written: string[]): RunOutcome['claims'] {
  return claims.map((claim) => ({
    path: claim,
    confirmed: written.some((w) => w === claim || w.endsWith(`/${claim.replace(/^\.?\/+/, '')}`) || basename(w) === basename(claim)),
  }));
}

function checkSummary(row: VerificationEvidenceRecord): string | null {
  const d = (row.detail ?? {}) as Record<string, unknown>;
  if (typeof d.reason === 'string') return d.reason;
  if (Array.isArray(d.failures) && d.failures.length) {
    return d.failures.map((f) => (f as { reason?: unknown }).reason).filter((r): r is string => typeof r === 'string').join('; ') || null;
  }
  if (typeof d.command === 'string') return `${d.command}${typeof d.exitCode === 'number' ? ` · exit ${d.exitCode}` : ''}`;
  if (Array.isArray(d.issues)) return d.issues.length ? `${d.issues.length} issue${d.issues.length === 1 ? '' : 's'}` : 'no issues';
  if (Array.isArray(d.schemaErrors)) return `${d.schemaErrors.length} schema error${d.schemaErrors.length === 1 ? '' : 's'}`;
  return null;
}

/**
 * The checks that judged this run: a worker's by its id or swarm node, or its
 * pipeline's within its lifetime; the root's are every check of its turn.
 */
export function checksForRun(agent: Pick<AgentRecord, 'id' | 'swarmNodeId' | 'createdAt' | 'completedAt' | 'origin'>, root: boolean, rows: VerificationEvidenceRecord[], now = new Date()): RunOutcome['checks'] {
  const end = (agent.completedAt ?? now).getTime() + 60_000;
  const inLifetime = (r: VerificationEvidenceRecord) => r.createdAt.getTime() >= agent.createdAt.getTime() && r.createdAt.getTime() <= end;
  const pipelineId = agent.origin?.pipelineId;
  return rows
    .filter((r) => root
      ? inLifetime(r)
      : r.nodeId === agent.id || (!!agent.swarmNodeId && r.nodeId === agent.swarmNodeId) || (!!pipelineId && r.pipelineId === pipelineId && inLifetime(r)))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((r) => ({ kind: r.kind, passed: r.passed, stage: r.stage ?? null, summary: checkSummary(r), at: r.createdAt.toISOString() }));
}

export async function readRunOutcome(agent: AgentRecord, root: boolean, status: MissionRun['status'], costUsd: number | null): Promise<RunOutcome> {
  const [events, evidence] = await Promise.all([
    agentEventRepository.outcomeEvents(agent.id),
    verificationEvidenceRepository.listForSession(agent.sessionId, 200),
  ]);

  const files = new Map<string, RunOutcome['files'][number]>();
  let answer: string | null = null;
  let eventError: string | null = null;
  for (const e of events) {
    const data = (e.data ?? {}) as Record<string, unknown>;
    if (e.type === 'action' && typeof data.path === 'string') {
      files.delete(data.path);
      files.set(data.path, { path: data.path, action: typeof data.action === 'string' ? data.action : 'write', at: e.createdAt.toISOString() });
    } else if (e.type === 'complete' && typeof data.result === 'string') answer = data.result;
    else if (e.type === 'error' && typeof data.error === 'string') eventError = data.error;
  }
  const written = [...files.values()].filter((f) => f.action !== 'delete').map((f) => f.path);

  return {
    status,
    completionReason: readAgentCompletionReason(agent.metadata) ?? null,
    error: agent.error ?? eventError,
    durationMs: agent.durationMs ?? null,
    totalTokens: agent.totalTokens ?? 0,
    costUsd,
    answer: answer ? answer.slice(0, ANSWER_LIMIT) : null,
    answerClipped: !!answer && answer.length > ANSWER_LIMIT,
    files: [...files.values()],
    claims: answer ? confirmClaims(claimedPaths(answer), written) : [],
    toolCalls: [...(agent.toolCalls ?? [])].sort((a, b) => b.count - a.count),
    checks: checksForRun(agent, root, evidence),
  };
}
