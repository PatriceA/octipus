import { eq, or, isNull, inArray } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { skills } from '@/db/schema/skills';
import type { Skill } from '@/db/schema/skills';

function buildPromptFragment(skill: Skill): string {
  // Prefer markdown content (Claude Code-style) over structured fields
  if (skill.content?.trim()) {
    return `## ${skill.name}\n\n${skill.content.trim()}`;
  }

  // Fallback to structured fields
  const lines = [
    `## ${skill.name}`,
    skill.description,
  ];
  const principles = skill.principles as string[];
  if (principles.length > 0) {
    lines.push('', '**Principles:** ' + principles.join(' | '));
  }
  const bp = skill.bestPractices as string[];
  if (bp.length > 0) {
    lines.push('', '**Best Practices:** ' + bp.join(' | '));
  }
  const ap = skill.antiPatterns as string[];
  if (ap.length > 0) {
    lines.push('', '**Avoid:** ' + ap.join(' | '));
  }
  const fw = skill.frameworks as string[];
  if (fw.length > 0) {
    lines.push('', '**Frameworks:** ' + fw.join(', '));
  }
  return lines.join('\n');
}

export class SkillRegistry {
  /** Get all skills (system + user-visible) */
  async getAll(userId?: string): Promise<Skill[]> {
    const db = getDb();
    if (userId) {
      return db.select().from(skills).where(
        or(eq(skills.isSystem, true), eq(skills.userId, userId))
      );
    }
    return db.select().from(skills);
  }

  /** Get a single skill by id */
  async get(skillId: string): Promise<Skill | undefined> {
    const db = getDb();
    const [skill] = await db.select().from(skills).where(eq(skills.id, skillId)).limit(1);
    return skill;
  }

  /** Get multiple skills by ids */
  async getByIds(skillIds: string[]): Promise<Skill[]> {
    if (skillIds.length === 0) return [];
    const db = getDb();
    return db.select().from(skills).where(inArray(skills.id, skillIds));
  }

  /** Build combined prompt fragment for a set of skill ids */
  async buildPromptFragment(skillIds: string[]): Promise<string> {
    const found = await this.getByIds(skillIds);
    if (found.length === 0) return '';
    return found.map(buildPromptFragment).join('\n\n');
  }
}

let instance: SkillRegistry | null = null;

export function getSkillRegistry(): SkillRegistry {
  if (!instance) {
    instance = new SkillRegistry();
  }
  return instance;
}
