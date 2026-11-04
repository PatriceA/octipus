/** A replay approval names one unchanged checkpoint and one resume mode. */
export interface PipelineReplayScope {
  pipelineId: string;
  checkpointSeq: number;
  headSeq: number;
  stateHash: string;
  nodeKey: string;
  attemptId: string | null;
  freshAttempt: boolean;
}
export interface PipelineReplayReceipt {
  requestId: string;
  userId: string;
  sessionId: string;
  workspaceId: string | null;
  scope: PipelineReplayScope;
}
export function pipelineReplayScope(value: unknown): PipelineReplayScope | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const s = value as PipelineReplayScope;
  return typeof s.pipelineId === 'string' && Number.isSafeInteger(s.checkpointSeq) && s.checkpointSeq > 0
    && Number.isSafeInteger(s.headSeq) && s.headSeq >= s.checkpointSeq && typeof s.stateHash === 'string' && /^[a-f0-9]{64}$/.test(s.stateHash)
    && typeof s.nodeKey === 'string' && !!s.nodeKey && (s.attemptId === null || typeof s.attemptId === 'string')
    && typeof s.freshAttempt === 'boolean' ? s : undefined;
}
