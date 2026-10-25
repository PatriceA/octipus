export interface PendingStageApproval {
  kind?: 'conversation' | 'permission';
  requestId: string;
  /** The stage worker's own request this one re-raises, or null when it could not be identified. */
  workerRequestId: string | null;
  stage: string;
  nodeKey: string;
  /** The stage attempt that was blocked; the grant is for it alone. */
  attemptId: string;
  /** `callFingerprint` of the blocked call, so an answer after a restart grants exactly it. */
  fingerprint: string | null;
  hostServices: boolean;
  itemId: string | null;
  item: string | null;
  toolId: string | null;
  action: string | null;
  toolName: string | null;
  /** The command or path the call acts on. */
  subject: string | null;
  reason: string;
}
