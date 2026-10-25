import type { Pipeline } from '@/db/schema/pipelines';

/** Host access is declared by a stage or explicitly approved for the run. */
export function stageHostServices(declared: { hostServices?: boolean }, pipeline: Pick<Pipeline, 'metadata' | 'userId'>): boolean {
  const grant = pipeline.metadata?.permissionProfile as { approvedBy?: string; profile?: { hostServices?: boolean } } | undefined;
  return declared.hostServices === true || grant?.approvedBy === pipeline.userId && grant?.profile?.hostServices === true;
}

/** Recognize unavailable execution prerequisites, never ordinary test failures. */
export function stageEnvironmentReason(text: string): string | undefined {
  return /(?:go|pnpm|docker|staticcheck|govulncheck):\s*(?:command not found|not found|no such file or directory|Kommando nicht gefunden)|(?:\.local\/go\/bin\/go|\/var\/run\/docker\.sock).{0,100}(?:not found|no such file|nicht gefunden)|(?:ECONNREFUSED|connection refused).{0,80}(?:localhost|127\.0\.0\.1|::1):(?:5432|5433|5443|25433)\b|Cannot connect to (?:the )?Docker daemon|Tool is not available to this agent|Scorer environment:|ENVIRONMENT BLOCKED:/i.test(text)
    ? text.slice(-4000) : undefined;
}

export class StageEnvironmentError extends Error {}
