/**
 * The protection level of a session (docs/PROTECTION-LEVELS.md, C6b): the
 * highest level of anything it has read — a tool result, a recalled passage,
 * an attached file, a document in the pipeline. It is only ever raised. Kept
 * in memory per process like the flow guard's label (security/flow-guard.ts)
 * and written through to `sessions.protection_level`, so a restart or another
 * process still knows what the conversation holds. Children share their
 * root's session id, so one level covers the whole agent family.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { effectiveProtectionLevel, type ProtectionLevel } from '@/shared/protection';

const MAX_SESSIONS = 2_000;
const levels = new Map<string, ProtectionLevel>();
/** Sessions whose stored level this process has merged (bounded). */
const loaded = new Set<string>();
/** The last stored-level write of each session, so writes land in order. */
const writes = new Map<string, Promise<void>>();

function isUuidShape(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function remember(sessionId: string, level: ProtectionLevel): void {
  levels.delete(sessionId); // re-insert: Map order doubles as LRU order
  levels.set(sessionId, level);
  if (levels.size > MAX_SESSIONS) levels.delete(levels.keys().next().value as string);
}

function rememberLoaded(sessionId: string): void {
  loaded.add(sessionId);
  if (loaded.size > MAX_SESSIONS * 50) loaded.delete(loaded.values().next().value as string);
}

/** The session's level: the highest it has read, 1 while it has read nothing leveled. */
export function sessionProtectionLevel(sessionId: string | undefined): ProtectionLevel {
  return (sessionId && levels.get(sessionId)) || 1;
}

/**
 * The session read content at `level` (null or undefined: unclear, which
 * counts as 4). Raises the session's level when that is higher; never
 * lowers it. Synchronous in memory, written through in the background.
 */
export function raiseSessionLevel(sessionId: string | undefined, level: number | null | undefined): void {
  if (!sessionId) return;
  const next = effectiveProtectionLevel(level);
  if (next <= sessionProtectionLevel(sessionId)) return;
  remember(sessionId, next);
  if (!isUuidShape(sessionId)) return;
  const write = (writes.get(sessionId) ?? Promise.resolve())
    .then(async () => (await import('@/db/repositories/session-repository')).sessionRepository.raiseProtectionLevel(sessionId, next))
    .catch(async (err) => (await import('@/utils/logger')).securityLogger.error({ err, sessionId }, 'protection level: persisting the session level failed'));
  writes.set(sessionId, write);
  void write.finally(() => { if (writes.get(sessionId) === write) writes.delete(sessionId); });
}

/** The highest level of several pieces of content (each null: unclear); undefined for none. */
export function highestLevel(levelsRead: readonly (number | null | undefined)[]): ProtectionLevel | undefined {
  if (levelsRead.length === 0) return undefined;
  return Math.max(...levelsRead.map((l) => effectiveProtectionLevel(l))) as ProtectionLevel;
}

/**
 * Merge the session's stored level into this process, once per session.
 * Throws when the row cannot be read: the caller decides where data may go
 * and must not decide on a level it could not load.
 */
export async function loadSessionLevel(sessionId: string | undefined): Promise<void> {
  if (!sessionId || loaded.has(sessionId)) return;
  if (!isUuidShape(sessionId)) { rememberLoaded(sessionId); return; }
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  const session = await sessionRepository.findById(sessionId);
  rememberLoaded(sessionId);
  const stored = session?.protectionLevel;
  if (stored != null && stored > sessionProtectionLevel(sessionId)) remember(sessionId, effectiveProtectionLevel(stored));
}

/**
 * Work on content outside any session (the document pipeline): its model
 * calls follow the content's level as a session's follow the session's.
 */
const contentLevel = new AsyncLocalStorage<ProtectionLevel>();
export function withContentLevel<T>(level: number | null | undefined, run: () => T): T {
  return contentLevel.run(effectiveProtectionLevel(level), run);
}
export function currentContentLevel(): ProtectionLevel | undefined {
  return contentLevel.getStore();
}

/** Test seam. */
export function resetSessionLevels(): void {
  levels.clear();
  loaded.clear();
}
