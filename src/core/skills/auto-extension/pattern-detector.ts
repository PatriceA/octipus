/**
 * Pattern detector for skill auto-extension.
 *
 * Observes root agent runs; fingerprints over (topic, toolSequence, briefShape).
 * When a fingerprint recurs ≥3 times per user within a rolling 14-day window
 * AND a suppression from a prior rejection isn't active, emits a proposal.
 *
 * Proposals NEVER auto-promote to experts. User approval required.
 * Opt-out via env `SKILL_AUTO_EXTENSION=false`.
 */

import { createHash } from 'crypto';
import { coreLogger } from '@/utils/logger';
import { type CacheEntry, getCache } from './cache';

export interface RunObservation {
  userId: string;
  topic?: string;
  toolSequence: string[];
  briefShape?: string;   // e.g. "how-to-install-X", "debug-Y-error". Optional narrowing label.
  sessionId: string;
  timestamp: Date;
}

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const MIN_OCCURRENCES = 3;

export function isAutoExtensionDisabled(): boolean {
  const v = process.env.SKILL_AUTO_EXTENSION;
  if (!v) return false;
  const n = v.trim().toLowerCase();
  return n === 'false' || n === '0' || n === 'no' || n === 'off';
}

export function computeFingerprint(obs: Pick<RunObservation, 'topic' | 'toolSequence' | 'briefShape'>): string {
  const topic = obs.topic ?? '_none';
  const tools = [...obs.toolSequence].sort().join(',');
  const shape = obs.briefShape ?? '_any';
  return createHash('sha256').update(`${topic}|${tools}|${shape}`).digest('hex').slice(0, 24);
}

export interface ProposalTrigger {
  fingerprint: string;
  userId: string;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  exemplarSessionIds: string[];
}

/**
 * Feed a run observation. Returns a ProposalTrigger when the fingerprint
 * crosses the MIN_OCCURRENCES threshold for the first time in the current
 * window (dedupes — further occurrences don't re-trigger until reset).
 */
export async function observe(obs: RunObservation): Promise<ProposalTrigger | null> {
  if (isAutoExtensionDisabled()) return null;

  const fp = computeFingerprint(obs);
  const cache = getCache();
  const key = `${obs.userId}:${fp}`;
  const now = obs.timestamp;

  const existing = await cache.get(key);
  const entry: CacheEntry = existing
    ? {
        ...existing,
        count: isInWindow(existing.firstSeen, now) ? existing.count + 1 : 1,
        firstSeen: isInWindow(existing.firstSeen, now) ? existing.firstSeen : now,
        lastSeen: now,
        exemplarSessionIds: [...existing.exemplarSessionIds, obs.sessionId].slice(-5),
      }
    : {
        fingerprint: fp,
        userId: obs.userId,
        count: 1,
        firstSeen: now,
        lastSeen: now,
        exemplarSessionIds: [obs.sessionId],
        triggered: false,
      };

  // Not yet at threshold → just store and exit.
  if (entry.count < MIN_OCCURRENCES) {
    await cache.set(key, entry);
    return null;
  }

  // Already triggered this cycle → don't re-trigger.
  if (entry.triggered) {
    await cache.set(key, entry);
    return null;
  }

  entry.triggered = true;
  await cache.set(key, entry);

  coreLogger.info({ userId: obs.userId, fingerprint: fp, count: entry.count }, 'Skill proposal triggered');

  return {
    fingerprint: fp,
    userId: obs.userId,
    count: entry.count,
    firstSeen: entry.firstSeen,
    lastSeen: entry.lastSeen,
    exemplarSessionIds: entry.exemplarSessionIds,
  };
}

function isInWindow(firstSeen: Date, now: Date): boolean {
  return now.getTime() - firstSeen.getTime() <= WINDOW_MS;
}
