import { skillRepository } from '@/db/repositories/skill-repository';
import { logger } from '@/utils/logger';

/**
 * Skill usage tracker — Phase 4 of the curator system.
 *
 * Every time the registry injects a skill into a prompt we want to bump
 * `usage_count` and `last_used_at`. Doing that synchronously on the
 * critical path would add a DB round-trip per worker turn, so the
 * tracker debounces:
 *
 *   - `recordSkillUsage(ids)` adds ids to an in-memory pending set.
 *   - A scheduled flush (default every 5s, or when the buffer reaches
 *     the threshold) writes one UPDATE per batch via
 *     `skillRepository.recordUsage`.
 *   - On process exit / disposal the buffer is flushed best-effort so
 *     short-lived runs don't drop counts.
 *
 * Failures are logged and discarded — losing a usage tick is acceptable;
 * blocking the worker for a counter is not.
 */

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_THRESHOLD = 32;

let pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight = false;
// Set when a flush is requested while one is already in flight. The
// in-flight flush honors this in its `finally` block and schedules
// another pass, so ids that piled up while the DB was busy never
// linger in the buffer waiting for the next debounce tick.
let pendingFollowUpFlush = false;

/** Record an injection event for each skill id. Caller is fire-and-forget. */
export function recordSkillUsage(skillIds: readonly string[]): void {
  if (skillIds.length === 0) return;
  for (const id of skillIds) pending.add(id);
  if (pending.size >= FLUSH_THRESHOLD) {
    void flushSkillUsage();
    return;
  }
  if (timer === null) {
    timer = setTimeout(() => {
      timer = null;
      void flushSkillUsage();
    }, FLUSH_INTERVAL_MS);
  }
}

/**
 * Force a flush now (test helper, also called on graceful shutdown).
 * Resolves once the pending batch is persisted or the attempt failed.
 */
export async function flushSkillUsage(): Promise<void> {
  if (flushInFlight) {
    // Race window: a record came in (or a forced flush was called)
    // while the previous flush was still awaiting the DB. Note it
    // and let the in-flight flush schedule a follow-up below — without
    // this latch the new ids would sit until the next 5s tick.
    pendingFollowUpFlush = true;
    return;
  }
  if (pending.size === 0) return;
  flushInFlight = true;
  const batch = Array.from(pending);
  pending = new Set();
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  try {
    await skillRepository.recordUsage(batch);
  } catch (err) {
    logger.warn(`[skill-usage-tracker] flush failed (${batch.length} ids): ${(err as Error).message}`);
  } finally {
    flushInFlight = false;
    if (pendingFollowUpFlush) {
      pendingFollowUpFlush = false;
      if (pending.size > 0) {
        // Schedule (don't await) so the original caller doesn't block
        // on a chain of flushes if the workload is bursty.
        void flushSkillUsage();
      }
    }
  }
}

/** Test helper — clears the buffer + timer without flushing. */
export function _resetSkillUsageTrackerForTesting(): void {
  pending = new Set();
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  flushInFlight = false;
  pendingFollowUpFlush = false;
}

/** Test helper — snapshot of the pending set without flushing. */
export function _peekPendingForTesting(): string[] {
  return Array.from(pending);
}
