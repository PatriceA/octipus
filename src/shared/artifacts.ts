/**
 * Artifact rules shared by the API, the agent tool and the web app.
 */

/** An artifact slug: lowercase letters, digits and dashes, 1–64 chars, no dash at either end. */
export const ARTIFACT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** A slug suggested from a title (may be empty when the title has no usable characters). */
export function slugFromTitle(title: string): string {
  return title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

/** Why a slug cannot be used: taken in the workspace, or already another workspace's public link. */
export type SlugConflictCode = 'slug_taken' | 'public_slug_taken';

/** The 409 body of a slug conflict (REST API), also what the agent tool reports. */
export interface SlugConflict {
  error: string;
  code: SlugConflictCode;
  slug: string;
  /** A slug free in the workspace (and not public elsewhere when publishing); null when none was found. */
  suggestedSlug: string | null;
}

/** Shortest time between scheduled agent refreshes of one artifact. */
export const AGENT_REFRESH_MIN_INTERVAL_MINUTES = 60;

/** Longest a stored refresh instruction may be. */
export const AGENT_REFRESH_MAX_INSTRUCTION_CHARS = 4000;

/** The schedules the web app offers (minutes); the API takes any value at or above the minimum, up to a week. */
export const AGENT_REFRESH_INTERVAL_CHOICES = [60, 6 * 60, 24 * 60, 7 * 24 * 60] as const;

/** Longest schedule interval the API accepts (a week). */
export const AGENT_REFRESH_MAX_INTERVAL_MINUTES = 7 * 24 * 60;

/** An artifact's agent refresh as its owner sees it (`GET /api/artifacts/:id/agent-refresh`). */
export interface AgentRefreshView {
  instruction: string;
  /** `agent`: written by the agent that created the page — the owner should review it before running it. */
  instructionSetBy: 'agent' | 'owner';
  /** Minutes between scheduled runs; null = manual only. */
  intervalMinutes: number | null;
  nextRunAt: string | null;
  /** Set when the server switched the schedule off (repeated failures, owner disabled, artifact gone). */
  scheduleDisabledReason: string | null;
  running: boolean;
  runStartedAt: string | null;
  lastAttemptAt: string | null;
  lastOutcome: 'success' | 'failed' | 'refused' | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
}
