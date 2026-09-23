import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { hiddenSkills } from '@/db/schema/hidden-skills';
import { skillSelections } from '@/db/schema/skill-selections';

export const hiddenSkillRepository = {
  async ids(userId: string): Promise<Set<string>> {
    const rows = await getDb().select().from(hiddenSkills).where(eq(hiddenSkills.userId, userId));
    return new Set(rows.map(row => row.skillId));
  },
  async hide(userId: string, ids: string[]): Promise<void> {
    await getDb().transaction(async tx => {
      await tx.insert(hiddenSkills).values([...new Set(ids)].map(skillId => ({ userId, skillId }))).onConflictDoNothing();
      // Removing a skill also removes this user's defaults and all session pins.
      await tx.delete(skillSelections).where(and(eq(skillSelections.userId, userId), inArray(skillSelections.skillId, ids)));
    });
  },
};
