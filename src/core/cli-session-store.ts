import { sessionGeneration } from '@/db/schema/sessions';
import { createHash } from 'node:crypto';
import { sessionRepository } from '@/db/repositories/session-repository';
import { canResume, CLI_RESUME } from '@/shared/cli-capabilities';
import type { SessionContext } from '@/db/schema/sessions';
import { withSessionConversation } from './session-history';

export type CliSessionRecord = {
  id: string;
  fingerprint: string;
  lastUsedAt: string;
  generation?: string;
  ownerAgentId?: string;
  acknowledged?: { id: string; createdAt: string };
};

/**
 * Fingerprints the parameters of a run that would change what a resumed
 * vendor session means. Not reversible, just needs to detect change — a
 * SHA-256 over the fields, hex-truncated.
 */
export function fingerprintRun(run: { model?: string; permissionMode?: string; planMode?: boolean; workingDirectory?: string; providerIdentity?: string; instructions?: string }): string {
  const material = JSON.stringify([run.model ?? '', run.permissionMode ?? '', run.planMode ?? false, run.workingDirectory ?? '', run.providerIdentity ?? '', run.instructions ?? '']);
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
  if (rec.generation !== sessionGeneration(ctx)) return null;
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
 * Writes ONE `cliSessions` entry in a single statement, rejected unless the
 * session is still in `rec.generation`. Children save outside the root
 * conversation lock, so rebuilding the whole map here would let parallel
 * children, the root and `acknowledgeProviderTurn` clobber each other.
 */
export async function saveCliSession(sessionId: string, adapterKey: string, rec: CliSessionRecord): Promise<void> {
  const generation = rec.generation ?? '';
  const saved = await sessionRepository.setContextKeyIfGeneration(sessionId, generation, ['cliSessions', adapterKey], { ...rec, generation });
  if (saved && isChildCliSessionKey(adapterKey)) await evictOldChildCliSessions(sessionId);
}

/** Most child task sessions kept per octipus session; the least recently used go first. */
export const MAX_CHILD_CLI_SESSIONS = 50;

/**
 * Cheap follow-up to a child save: over the bound, drop the oldest child keys
 * by `lastUsedAt`, one per-key delete each (a concurrent save of another key
 * is never rewritten). Root adapter keys are never evicted.
 */
async function evictOldChildCliSessions(sessionId: string): Promise<void> {
  const session = await sessionRepository.findById(sessionId);
  const children = Object.entries(session?.context?.cliSessions ?? {}).filter(([key]) => isChildCliSessionKey(key));
  if (children.length <= MAX_CHILD_CLI_SESSIONS) return;
  children.sort(([, a], [, b]) => (a.lastUsedAt ?? '').localeCompare(b.lastUsedAt ?? ''));
  for (const [key] of children.slice(0, children.length - MAX_CHILD_CLI_SESSIONS)) await dropCliSession(sessionId, key);
}

export async function dropCliSession(sessionId: string, adapterKey: string): Promise<void> {
  await sessionRepository.setContextKey(sessionId, ['cliSessions', adapterKey], undefined);
}

const CHILD_KEY_SEPARATOR = '::';

/** `<adapter>::` for every resumable adapter: the only prefixes a child key can have. */
export const CHILD_CLI_SESSION_KEY_PREFIXES = Object.keys(CLI_RESUME).map(adapterKey => `${adapterKey}${CHILD_KEY_SEPARATOR}`);

/**
 * Store key for a child agent's vendor session, continued per (parent scope,
 * role, task) rather than per octipus session. Lives beside the root's adapter
 * keys in `cliSessions`, so /clear (which drops the map) drops these too;
 * compaction keeps them (`isChildCliSessionKey`).
 */
export function childCliSessionKey(adapterKey: string, resumeKey: string): string {
  return `${adapterKey}${CHILD_KEY_SEPARATOR}${resumeKey}`;
}

/** A child task key (`<resumable adapter>::…`), which compaction keeps and eviction bounds. */
export function isChildCliSessionKey(key: string): boolean {
  return CHILD_CLI_SESSION_KEY_PREFIXES.some(prefix => key.startsWith(prefix));
}

// Child store keys held by a live agent. Two concurrent children with the same
// key must never share one vendor session. In-memory, so this guards agents in
// ONE server process only — which is where the swarm spawner runs children.
const liveHolders = new Map<string, string>();
const claimsByAgent = new Map<string, Set<string>>();

/** Claims `key` for `agentId`; false when another live agent already holds it. */
export function claimCliSession(sessionId: string, key: string, agentId: string): boolean {
  const slot = `${sessionId}\0${key}`;
  const holder = liveHolders.get(slot);
  if (holder && holder !== agentId) return false;
  liveHolders.set(slot, agentId);
  let slots = claimsByAgent.get(agentId);
  if (!slots) claimsByAgent.set(agentId, slots = new Set());
  slots.add(slot);
  return true;
}

/** The live agent holding `key`, if any. */
export function cliSessionHolder(sessionId: string, key: string): string | undefined {
  return liveHolders.get(`${sessionId}\0${key}`);
}

/** Drops every claim `agentId` holds: when its run settles, or its stopped process exits. */
export function releaseCliSessions(agentId: string): void {
  for (const slot of claimsByAgent.get(agentId) ?? []) if (liveHolders.get(slot) === agentId) liveHolders.delete(slot);
  claimsByAgent.delete(agentId);
}

/** The final persisted Octipus answer is now part of this vendor turn. */
export async function acknowledgeProviderTurn(sessionId: string, agentId: string, cursor: { id: string; createdAt: Date }): Promise<void> {
  await withSessionConversation(sessionId, async () => {
  const session = await sessionRepository.findById(sessionId);
  for (const [key, rec] of Object.entries(session?.context?.cliSessions ?? {})) {
    if (rec.ownerAgentId === agentId) await saveCliSession(sessionId, key, {
      ...rec, acknowledged: { id: cursor.id, createdAt: cursor.createdAt.toISOString() },
    });
  }
  const native = session?.context?.nativeConversation;
  if (native?.ownerAgentId === agentId) await sessionRepository.patchContextIfGeneration(sessionId, native.generation, {
    nativeConversation: { ...native, acknowledged: { id: cursor.id, createdAt: cursor.createdAt.toISOString() } },
  });
  });
}
