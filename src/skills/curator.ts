import { skillRepository } from '@/db/repositories/skill-repository';
import type { Skill } from '@/db/schema/skills';
import { logger } from '@/utils/logger';

/**
 * Skill curator — periodic maintenance of the skill collection.
 *
 * Hermes-inspired learning-loop primitive. The curator scans for stale
 * skills (not loaded into a prompt for `unusedDays`) and either flags
 * them for review or auto-archives them. Future iterations can spawn a
 * background agent to refresh content, but the read+archive primitive
 * is enough to keep the registry from accumulating dead entries.
 *
 * Designed to be triggered by an idle-tick scheduler (see
 * `skill-curator-scheduler.ts`) or invoked directly from a CLI / admin
 * endpoint. Pure side-effect-free read + explicit archive call so
 * callers control when writes happen.
 */

export const DEFAULT_STALE_DAYS = 90;
export const DEFAULT_REVIEW_DAYS = 30;

export interface CuratorReport {
  /** Skills the curator did NOT touch but flags for human review. */
  flagged: Array<{ skill: Skill; reason: string }>;
  /** Skills the curator auto-archived this run. */
  archived: Array<{ skill: Skill; reason: string }>;
  /** Total stale skills inspected. */
  inspected: number;
}

export interface RunOptions {
  /** Days since last use beyond which a skill is eligible for archive. */
  archiveAfterDays?: number;
  /** Days since last use beyond which a skill is flagged for review. */
  reviewAfterDays?: number;
  /** Max rows to inspect in one pass. Keeps the curator bounded on big collections. */
  limit?: number;
  /** If false, no writes happen — useful for dry-run / preview. */
  applyArchive?: boolean;
}

/**
 * One curator pass. Resolves with a report describing what changed and
 * what's flagged. Safe to call from a cron, an admin button, or a test.
 */
export async function runSkillCurator(opts: RunOptions = {}): Promise<CuratorReport> {
  const archiveAfterDays = opts.archiveAfterDays ?? DEFAULT_STALE_DAYS;
  const reviewAfterDays = opts.reviewAfterDays ?? DEFAULT_REVIEW_DAYS;
  const limit = opts.limit ?? 100;
  const applyArchive = opts.applyArchive ?? true;

  const stale = await skillRepository.findStale(reviewAfterDays, limit);
  const flagged: CuratorReport['flagged'] = [];
  const archived: CuratorReport['archived'] = [];

  const archiveCutoff = Date.now() - archiveAfterDays * 24 * 60 * 60 * 1000;
  for (const skill of stale) {
    const lastUsed = skill.lastUsedAt ? skill.lastUsedAt.getTime() : 0;
    if (lastUsed < archiveCutoff) {
      const reason = skill.lastUsedAt
        ? `unused for >${archiveAfterDays} days (last_used_at=${skill.lastUsedAt.toISOString()})`
        : `never used and older than ${archiveAfterDays} days`;
      if (applyArchive) {
        try {
          await skillRepository.archive(skill.id, `auto-curator: ${reason}`);
          archived.push({ skill, reason });
        } catch (err) {
          logger.warn(`[skill-curator] archive failed for ${skill.id}: ${(err as Error).message}`);
          flagged.push({ skill, reason: `archive failed: ${(err as Error).message}` });
        }
      } else {
        flagged.push({ skill, reason: `would-archive: ${reason}` });
      }
    } else {
      flagged.push({
        skill,
        reason: skill.lastUsedAt
          ? `unused for >${reviewAfterDays} days (last_used_at=${skill.lastUsedAt.toISOString()})`
          : `never used`,
      });
    }
  }

  logger.info(
    `[skill-curator] pass complete: inspected=${stale.length} archived=${archived.length} flagged=${flagged.length}`,
  );
  return { flagged, archived, inspected: stale.length };
}
