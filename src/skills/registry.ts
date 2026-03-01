import { BaseSkill } from './base-skill';
import type { ToolHandler } from '@/core/agent-worker';
import type { SkillManifest } from '@/core/types';
import { skillLogger } from '@/utils/logger';

export interface SkillRegistryOptions {
  autoInitialize?: boolean;
}

export class SkillRegistry {
  private skills: Map<string, BaseSkill> = new Map();
  private initialized: Set<string> = new Set();

  /**
   * Register a skill
   */
  async register(skill: BaseSkill, options?: SkillRegistryOptions): Promise<void> {
    if (this.skills.has(skill.id)) {
      throw new Error(`Skill already registered: ${skill.id}`);
    }

    this.skills.set(skill.id, skill);

    if (options?.autoInitialize !== false) {
      await this.initialize(skill.id);
    }

    skillLogger.info({ skillId: skill.id, name: skill.name, version: skill.version }, 'Skill registered');
  }

  /**
   * Initialize a skill
   */
  async initialize(skillId: string): Promise<void> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    if (this.initialized.has(skillId)) {
      return;
    }

    await skill.initialize();
    this.initialized.add(skillId);
  }

  /**
   * Initialize all registered skills
   */
  async initializeAll(): Promise<void> {
    for (const skillId of this.skills.keys()) {
      if (!this.initialized.has(skillId)) {
        await this.initialize(skillId);
      }
    }
  }

  /**
   * Get a skill by ID
   */
  get(skillId: string): BaseSkill | undefined {
    return this.skills.get(skillId);
  }

  /**
   * Get all registered skills
   */
  getAll(): BaseSkill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Get all skill manifests
   */
  getManifests(): SkillManifest[] {
    return this.getAll().map((skill) => skill.getManifest());
  }

  /**
   * Get all tool handlers from all skills
   */
  getAllToolHandlers(): ToolHandler[] {
    const handlers: ToolHandler[] = [];

    for (const skill of this.skills.values()) {
      if (this.initialized.has(skill.id)) {
        handlers.push(...skill.getToolHandlers());
      }
    }

    return handlers;
  }

  /**
   * Get tool handlers for specific skills
   */
  getToolHandlersForSkills(skillIds: string[]): ToolHandler[] {
    const handlers: ToolHandler[] = [];

    for (const skillId of skillIds) {
      const skill = this.skills.get(skillId);
      if (skill && this.initialized.has(skillId)) {
        handlers.push(...skill.getToolHandlers());
      }
    }

    return handlers;
  }

  /**
   * Find a tool handler by full name (skillId.toolName)
   */
  findTool(fullName: string): ToolHandler | undefined {
    const [skillId, toolName] = fullName.split('.');
    const skill = this.skills.get(skillId);

    if (!skill || !this.initialized.has(skillId)) {
      return undefined;
    }

    return skill.getTool(toolName);
  }

  /**
   * Unregister a skill
   */
  async unregister(skillId: string): Promise<boolean> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      return false;
    }

    if (this.initialized.has(skillId)) {
      await skill.shutdown();
      this.initialized.delete(skillId);
    }

    this.skills.delete(skillId);
    skillLogger.info({ skillId }, 'Skill unregistered');

    return true;
  }

  /**
   * Shutdown all skills
   */
  async shutdownAll(): Promise<void> {
    for (const [skillId, skill] of this.skills) {
      if (this.initialized.has(skillId)) {
        await skill.shutdown();
        this.initialized.delete(skillId);
      }
    }

    skillLogger.info('All skills shut down');
  }

  /**
   * Check if a skill is registered
   */
  has(skillId: string): boolean {
    return this.skills.has(skillId);
  }

  /**
   * Check if a skill is initialized
   */
  isInitialized(skillId: string): boolean {
    return this.initialized.has(skillId);
  }

  /**
   * Get skill count
   */
  get count(): number {
    return this.skills.size;
  }

  /**
   * Get initialized skill count
   */
  get initializedCount(): number {
    return this.initialized.size;
  }
}

// Singleton instance
let registryInstance: SkillRegistry | null = null;

export function getSkillRegistry(): SkillRegistry {
  if (!registryInstance) {
    registryInstance = new SkillRegistry();
  }
  return registryInstance;
}
