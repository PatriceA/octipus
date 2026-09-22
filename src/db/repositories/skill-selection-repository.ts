import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { skillSelections } from '@/db/schema/skill-selections';

export type SkillMode = 'automatic' | 'always' | 'session';

export const skillSelectionRepository = {
  async list(userId: string, sessionId?: string) {
    return getDb().select().from(skillSelections).where(and(
      eq(skillSelections.userId, userId),
      inArray(skillSelections.scope, sessionId ? ['', sessionId] : ['']),
    ));
  },

  async set(userId: string, skillId: string, mode: SkillMode, sessionId?: string) {
    if (mode === 'session' && !sessionId) throw new Error('A session is required');
    await getDb().transaction(async tx => {
      const scope = mode === 'always' ? '' : sessionId ?? '';
      const where = and(eq(skillSelections.userId, userId), eq(skillSelections.skillId, skillId), eq(skillSelections.scope, scope));
      if (mode === 'automatic' && !sessionId) {
        await tx.delete(skillSelections).where(where);
      } else {
        await tx.insert(skillSelections).values({ userId, skillId, scope, mode })
          .onConflictDoUpdate({ target: [skillSelections.userId, skillSelections.scope, skillSelections.skillId], set: { mode } });
      }
      // Choosing Always also clears this session's override.
      if (mode === 'always' && sessionId) {
        await tx.delete(skillSelections).where(and(eq(skillSelections.userId, userId), eq(skillSelections.skillId, skillId), eq(skillSelections.scope, sessionId)));
      }
    });
  },
};
