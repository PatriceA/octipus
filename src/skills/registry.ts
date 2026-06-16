import { skillRepository } from '@/db/repositories/skill-repository';
import type { Skill } from '@/db/schema/skills';
import { logger } from '@/utils/logger';
import { isExternalSkillId, loadExternalSkills, type LoadExternalSkillsOptions } from './external-loader';
import { recordSkillUsage } from './usage-tracker';

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
 * One-line summary for a skill, used in the worker prompt index. Full
 * content stays out of the prompt — the worker pulls it on demand via
 * the built-in `get_skill` tool. This cuts a typical expert prompt
 * from 40–80k tokens of skill dumps down to a few hundred, and the
 * agent only loads what it actually needs.
 */
function buildPromptSummary(skill: Skill): string {
  const desc = (skill.description || '').replace(/\s+/g, ' ').trim();
  // Cap each entry so a runaway description can't blow up the index.
  const capped = desc.length > 200 ? desc.slice(0, 197) + '…' : desc;
  return `- \`${skill.id}\` **${skill.name}** — ${capped || '(no description)'}`;
}

/**
 * High-level skill operations. Goes through `skillRepository` for DB rows
 * and `external-loader` for filesystem skills (agentskills.io spec).
 *
 * External skills have ids prefixed `external:` and live in memory only —
 * they do not appear in `skill_topic_assignments` and cannot be edited via
 * the API; they reload from disk via `loadExternal()`.
 */
export class SkillRegistry {
  private external: Map<string, Skill> = new Map();
  private externalLoaded = false;

  /**
   * Scan filesystem locations once and cache. Idempotent — call again to
   * pick up new files (e.g. from a `/reload` command).
   */
  loadExternal(opts: LoadExternalSkillsOptions = {}): void {
    try {
      const skills = loadExternalSkills(opts);
      this.external = new Map(skills.map(s => [s.id, s]));
      this.externalLoaded = true;
      if (skills.length > 0) {
        logger.info(`[skills] loaded ${skills.length} external skills from filesystem`);
      }
    } catch (err) {
      logger.warn(`[skills] external skill discovery failed: ${(err as Error).message}`);
      this.external = new Map();
      this.externalLoaded = true;
    }
  }

  private ensureLoaded(): void {
    if (!this.externalLoaded) this.loadExternal();
  }

  /** Read-only view of cached external skills (test / debug helper). */
  getExternalSkills(): Skill[] {
    this.ensureLoaded();
    return [...this.external.values()];
  }

  async getAll(userId?: string): Promise<Skill[]> {
    this.ensureLoaded();
    const dbSkills = await skillRepository.findAll(userId);
    return [...dbSkills, ...this.external.values()];
  }

  async get(skillId: string): Promise<Skill | undefined> {
    this.ensureLoaded();
    if (isExternalSkillId(skillId)) return this.external.get(skillId);
    return skillRepository.findById(skillId);
  }

  async getByIds(skillIds: string[]): Promise<Skill[]> {
    this.ensureLoaded();
    const externalIds = skillIds.filter(isExternalSkillId);
    const dbIds = skillIds.filter(id => !isExternalSkillId(id));

    const [dbRows, externalRows] = await Promise.all([
      skillRepository.findByIds(dbIds),
      Promise.resolve(
        externalIds
          .map(id => this.external.get(id))
          .filter((s): s is Skill => s !== undefined),
      ),
    ]);

    return [...dbRows, ...externalRows];
  }

  async buildPromptFragment(skillIds: string[]): Promise<string> {
    const found = await this.getByIds(skillIds);
    if (found.length === 0) return '';
    recordSkillUsage(found.filter((s) => !isExternalSkillId(s.id)).map((s) => s.id));
    return found.map(buildPromptFragment).join('\n\n');
  }

  /**
   * Index-style listing: one bullet per skill (name + short
   * description). Use this in worker system prompts to keep token
   * cost flat regardless of how many skills the role inherits; the
   * agent loads full content for a specific skill via the built-in
   * `get_skill` tool when it actually needs it.
   */
  async buildPromptSummary(skillIds: string[]): Promise<string> {
    if (skillIds.length === 0) return '';
    const found = await this.getByIds(skillIds);
    if (found.length === 0) return '';
    // Summary-only injection still counts as usage — the LLM saw the skill
    // exists and may load its full content via the MCP tool.
    recordSkillUsage(found.filter((s) => !isExternalSkillId(s.id)).map((s) => s.id));
    const lines = [
      'Available skills (call `get_skill` with the id to load the full spec):',
      ...found.map(buildPromptSummary),
    ];
    return lines.join('\n');
  }

  /**
   * Render one skill's full content for on-demand loading (the built-in
   * `get_skill` tool). Returns null if the id is unknown. Counts as usage —
   * the agent asked for the body, not just the index.
   */
  async renderSkill(skillId: string): Promise<string | null> {
    const skill = await this.get(skillId);
    if (!skill) return null;
    if (!isExternalSkillId(skill.id)) recordSkillUsage([skill.id]);
    return buildPromptFragment(skill);
  }

  async getActiveSkillsForTopic(topic: string): Promise<Skill[]> {
    return skillRepository.findActiveByTopic(topic);
  }

  async buildTopicPromptFragment(topic: string): Promise<string> {
    const found = await this.getActiveSkillsForTopic(topic);
    if (found.length === 0) return '';
    recordSkillUsage(found.map((s) => s.id));
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

/** Reset the singleton — used by tests and `/reload`. */
export function resetSkillRegistry(): void {
  instance = null;
}
