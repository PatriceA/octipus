import { createHash } from 'node:crypto';
import { sessionRepository } from '@/db/repositories/session-repository';
import { canResume } from '@/shared/cli-capabilities';
import type { SessionContext } from '@/db/schema/sessions';

export type CliSessionRecord = {
  id: string;
  fingerprint: string;
  lastUsedAt: string;
};

/**
 * Fingerprints the parameters of a run that would change what a resumed
 * vendor session means. Not reversible, just needs to detect change — a
 * SHA-256 over the fields, hex-truncated.
 */
export function fingerprintRun(run: { model?: string; permissionMode?: string; planMode?: boolean; workingDirectory?: string }): string {
  const material = JSON.stringify([run.model ?? '', run.permissionMode ?? '', run.planMode ?? false, run.workingDirectory ?? '']);
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/**
 * Reads the stored vendor session for this octipus session + adapter, scoped
 * strictly to `sessionId` — never falls back to another session's stored id.
 * Returns null unless the fingerprint matches exactly.
 */
export async function loadCliSession(sessionId: string, adapterKey: string, fingerprint: string): Promise<CliSessionRecord | null> {
  const session = await sessionRepository.findById(sessionId);
  const ctx = session?.context as SessionContext | undefined;
  const rec = ctx?.cliSessions?.[adapterKey];
  if (!rec || rec.fingerprint !== fingerprint) return null;
  // Defence in depth: a /clear sets `clearedAt` and is supposed to drop
  // `cliSessions` at the write (both command paths do this), but a stored
  // record that somehow survives a clear (a write path that misses it, a
  // fire-and-forget save racing in from a turn started before the clear)
  // must still never be resumed — that would hand the vendor CLI back a
  // conversation the user explicitly cleared. A record saved AFTER the
  // clear (lastUsedAt > clearedAt) is a legitimate post-clear session and is
  // still resumable.
  if (ctx?.clearedAt && rec.lastUsedAt <= ctx.clearedAt) return null;
  return rec;
}

/**
 * Whether a run with this fingerprint will resume a vendor session rather
 * than start cold — the seam `root-runner` uses to decide, BEFORE it
 * assembles the prompt, whether the history/summary blocks it would render
 * are redundant (the vendor already holds them). Pure read: never creates or
 * mutates a stored session.
 */
export async function willResumeCliSession(sessionId: string, adapterKey: string, fingerprint: string): Promise<boolean> {
  if (!canResume(adapterKey)) return false;
  return (await loadCliSession(sessionId, adapterKey, fingerprint)) !== null;
}

/**
 * Both writers patch ONE key. They used to read the whole `context`, spread it
 * and write it back — and both are called fire-and-forget from the middle of a
 * turn (`cli-agent-worker.ts`), so a `/clear` that landed in between was
 * restored wholesale: its `clearedAt` and summary reset, and the cleared
 * conversation resumed on the next turn. No overlapping turns required.
 */
export async function saveCliSession(sessionId: string, adapterKey: string, rec: CliSessionRecord): Promise<void> {
  await sessionRepository.setContextKey(sessionId, ['cliSessions', adapterKey], rec);
}

export async function dropCliSession(sessionId: string, adapterKey: string): Promise<void> {
  await sessionRepository.setContextKey(sessionId, ['cliSessions', adapterKey], undefined);
}
