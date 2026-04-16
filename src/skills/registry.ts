import { skillRepository } from '@/db/repositories/skill-repository';
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

/**
 * High-level skill operations. Goes through `skillRepository` for all
 * data access — see DESIGN.md "Repository pattern consistency".
 */
export class SkillRegistry {
  async getAll(userId?: string): Promise<Skill[]> {
    return skillRepository.findAll(userId);
  }

  async get(skillId: string): Promise<Skill | undefined> {
    return skillRepository.findById(skillId);
  }

  async getByIds(skillIds: string[]): Promise<Skill[]> {
    return skillRepository.findByIds(skillIds);
  }

  async buildPromptFragment(skillIds: string[]): Promise<string> {
    const found = await this.getByIds(skillIds);
    if (found.length === 0) return '';
    return found.map(buildPromptFragment).join('\n\n');
  }

  async getActiveSkillsForTopic(topic: string): Promise<Skill[]> {
    return skillRepository.findActiveByTopic(topic);
  }

  async buildTopicPromptFragment(topic: string): Promise<string> {
    const found = await this.getActiveSkillsForTopic(topic);
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
