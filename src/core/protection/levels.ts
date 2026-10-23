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

/** The entity's stored level and the level it inherits (a record from its type), or null when the scope does not reach it. */
async function currentOf(repos: ContentRepos, entity: ProtectedEntity, id: string): Promise<{ own: number | null; inherited: number | null } | null> {
  switch (entity) {
    case 'document': {
      const row = await repos.documents.findById(id);
      return row ? { own: row.protectionLevel, inherited: null } : null;
    }
    case 'case': {
      const row = await repos.cases.findById(id);
      return row ? { own: row.protectionLevel, inherited: null } : null;
    }
    case 'record': {
      const row = await repos.records.findById(id);
      if (!row) return null;
      const type = await repos.recordTypes.findById(row.typeId);
      return { own: row.protectionLevel, inherited: type?.defaultProtectionLevel ?? null };
    }
    case 'mail': {
      const row = await repos.mail.message(id);
      return row ? { own: row.protectionLevel, inherited: null } : null;
    }
  }
}

async function store(repos: ContentRepos, entity: ProtectedEntity, id: string, level: number | null): Promise<boolean> {
  switch (entity) {
    case 'document': return (await repos.documents.setProtectionLevel(id, level)) !== null;
    case 'case': return (await repos.cases.update(id, { protectionLevel: level })) !== null;
    case 'record': return (await repos.records.setProtectionLevel(id, level)) !== null;
    case 'mail': return (await repos.mail.setProtectionLevel(id, level)) !== null;
  }
}

/**
 * Set the protection level of one piece of content. `by: 'agent'` may only
 * raise the effective level; `by: 'person'` may set any level or clear it.
 * Null when the scope does not reach the content; throws
 * `ProtectionLevelError` for a level or a change that is not allowed.
 */
export async function setProtectionLevel(
  repos: ContentRepos,
  entity: ProtectedEntity,
  id: string,
  level: number | null,
  by: 'person' | 'agent',
): Promise<LevelChange | null> {
  if (level !== null && !isProtectionLevel(level)) throw new ProtectionLevelError('A protection level is 1, 2, 3 or 4');
  const current = await currentOf(repos, entity, id);
  if (!current) return null;
  const from = effectiveProtectionLevel(current.own, current.inherited);
  if (by === 'agent') {
    if (level === null) throw new ProtectionLevelError('Only a person can mark content unclear again');
    if (level < from) throw new ProtectionLevelError(`Only a person can lower a protection level (it is ${from})`);
  }
  if (!(await store(repos, entity, id, level))) return null;
  return { entity, id, from, level, effective: effectiveProtectionLevel(level, current.inherited) };
}
