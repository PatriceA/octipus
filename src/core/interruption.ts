export interface Interruption {
  reason: string;
  actor: string;
  at: string;
  checkpoint?: { pipelineId?: unknown; nodeKey?: unknown; attemptId?: unknown };
}
export class WorkerInterruptedError extends Error {
  constructor(readonly interruption: Interruption) {
    super(`Worker interrupted (${interruption.reason}); actor: ${interruption.actor}. Resume from the saved checkpoint.`);
  }
}
