import { createHash } from 'node:crypto';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { SessionContext } from '@/db/schema/sessions';

export type CliSessionRecord = {
  id: string;
  fingerprint: string;
  lastUsedAt: string;
  /** Tokens the vendor CLI has reported so far for this session; seeds reconciliation. */
  reportedTokens: number;
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
  const rec = (session?.context as SessionContext | undefined)?.cliSessions?.[adapterKey];
  if (!rec || rec.fingerprint !== fingerprint) return null;
  // Older stored records (pre token-reconciliation) may lack reportedTokens at runtime.
  return { ...rec, reportedTokens: rec.reportedTokens ?? 0 };
}

export async function saveCliSession(sessionId: string, adapterKey: string, rec: CliSessionRecord): Promise<void> {
  const session = await sessionRepository.findById(sessionId);
  const context = (session?.context as SessionContext | undefined) ?? {};
  await sessionRepository.update(sessionId, {
    context: { ...context, cliSessions: { ...context.cliSessions, [adapterKey]: rec } },
  });
}

export async function dropCliSession(sessionId: string, adapterKey: string): Promise<void> {
  const session = await sessionRepository.findById(sessionId);
  const context = (session?.context as SessionContext | undefined) ?? {};
  if (!context.cliSessions?.[adapterKey]) return;
  const cliSessions = { ...context.cliSessions };
  delete cliSessions[adapterKey];
  await sessionRepository.update(sessionId, { context: { ...context, cliSessions } });
}
