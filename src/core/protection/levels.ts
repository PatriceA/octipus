/**
 * Setting protection levels (docs/PROTECTION-LEVELS.md). A level says where
 * content may be processed, so lowering one is a decision for a person: an
 * agent may raise a level (it found health data in a document) but never
 * lower one, and never mark content unclear-again in place of a level. A
 * person may set any level, or clear it back to unclear (4).
 */
import type { ContentRepos } from '@/db/repositories/content';
import { effectiveProtectionLevel, isProtectionLevel, type ProtectionLevel } from '@/shared/protection';

export const PROTECTED_ENTITIES = ['document', 'case', 'record', 'mail'] as const;
export type ProtectedEntity = (typeof PROTECTED_ENTITIES)[number];

export function isProtectedEntity(value: unknown): value is ProtectedEntity {
  return typeof value === 'string' && (PROTECTED_ENTITIES as readonly string[]).includes(value);
}

export class ProtectionLevelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectionLevelError';
  }
}

export interface LevelChange {
  entity: ProtectedEntity;
  id: string;
  from: ProtectionLevel;
  /** The stored level now; null is unclear (4). */
  level: number | null;
  effective: ProtectionLevel;
}

/**
 * The entity's stored level, or undefined when the scope does not reach it.
 * Through the scope only: an admin's by-id read of another user's content
 * does not extend to its level. A record copies its type's default when it
 * is created; from then on its own level is all that counts.
 */
async function storedLevel(repos: ContentRepos, entity: ProtectedEntity, id: string): Promise<number | null | undefined> {
  switch (entity) {
    case 'document': return (await repos.documents.findInScope(id))?.protectionLevel;
    case 'case': return (await repos.cases.findInScope(id))?.protectionLevel;
    case 'record': return (await repos.records.findById(id))?.protectionLevel;
    case 'mail': return (await repos.mail.message(id))?.protectionLevel;
  }
}

async function store(repos: ContentRepos, entity: ProtectedEntity, id: string, level: number | null, onlyRaise: boolean): Promise<boolean> {
  switch (entity) {
    case 'document': return (await repos.documents.setProtectionLevel(id, level, onlyRaise)) !== null;
    case 'case': return (await repos.cases.setProtectionLevel(id, level, onlyRaise)) !== null;
    case 'record': return (await repos.records.setProtectionLevel(id, level, onlyRaise)) !== null;
    case 'mail': return (await repos.mail.setProtectionLevel(id, level, onlyRaise)) !== null;
  }
}

/**
 * Set the protection level of one piece of content. `by: 'agent'` may only
 * raise the level: the write itself carries the condition, so a person's
 * change landing meanwhile is never undone downwards. `by: 'person'` may set
 * any level, or clear it to unclear (4). Null when the scope does not reach
 * the content; throws `ProtectionLevelError` for a level or a change that is
 * not allowed.
 */
export async function setProtectionLevel(
  repos: ContentRepos,
  entity: ProtectedEntity,
  id: string,
  level: number | null,
  by: 'person' | 'agent',
): Promise<LevelChange | null> {
  if (level !== null && !isProtectionLevel(level)) throw new ProtectionLevelError('A protection level is 1, 2, 3 or 4');
  if (by === 'agent' && level === null) throw new ProtectionLevelError('Only a person can mark content unclear again');
  const stored = await storedLevel(repos, entity, id);
  if (stored === undefined) return null;
  const from = effectiveProtectionLevel(stored);
  if (by === 'agent' && (level as number) < from) throw new ProtectionLevelError(`Only a person can lower a protection level (it is ${from})`);
  if (!(await store(repos, entity, id, level, by === 'agent'))) {
    // Gone meanwhile, or (an agent's write) raised above the asked level meanwhile.
    const now = await storedLevel(repos, entity, id);
    if (now === undefined) return null;
    throw new ProtectionLevelError(`Only a person can lower a protection level (it is ${effectiveProtectionLevel(now)})`);
  }
  return { entity, id, from, level, effective: effectiveProtectionLevel(level) };
}
