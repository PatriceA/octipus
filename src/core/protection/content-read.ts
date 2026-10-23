/**
 * Content an agent reads raises its session's protection level
 * (docs/PROTECTION-LEVELS.md, C6b). Tools that return leveled content call
 * `readLevel` for each piece; search hits and recalled passages go through
 * `readKnowledge`, which looks up the levels of the documents they come from.
 * The level is raised whether or not the `protection` module is on: what was
 * read stays known if the module is switched on later.
 */
import { visibleProtectionLevel } from './visible';
import { highestLevel, raiseSessionLevel } from './session-level';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The agent of `context` read content at `level` (null: unclear, 4). Returns
 * the level as the agent sees it (`visibleProtectionLevel`).
 */
export function readLevel(context: { sessionId?: string }, level: number | null | undefined): number | undefined {
  raiseSessionLevel(context.sessionId, level);
  return visibleProtectionLevel(level);
}

/**
 * The session was handed these knowledge hits. Chunks of a document
 * (`doc:<id>`) carry the document's level; a document gone since it was
 * indexed counts as unclear. Notes and other sources carry no level yet.
 */
export async function readKnowledge(sessionId: string | undefined, hits: readonly { sourceId?: string | null }[]): Promise<void> {
  if (!sessionId) return;
  const ids = [...new Set(hits.map((h) => h.sourceId ?? '').filter((s) => s.startsWith('doc:')).map((s) => s.slice(4)))];
  if (ids.length === 0) return;
  try {
    const { documentRepository } = await import('@/db/repositories/document-repository');
    const stored = await documentRepository.protectionLevelsSystem(ids.filter((id) => UUID_RE.test(id)));
    const level = highestLevel(ids.map((id) => stored.get(id) ?? null));
    if (level !== undefined) raiseSessionLevel(sessionId, level);
  } catch {
    // Levels that cannot be read count as unclear: the hits were handed over.
    raiseSessionLevel(sessionId, null);
  }
}
