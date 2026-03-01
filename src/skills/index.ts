export { BaseSkill, createParameterSchema, type SkillContext, type ToolExecutionOptions } from './base-skill';
export { SkillRegistry, getSkillRegistry, type SkillRegistryOptions } from './registry';

// Built-in skills
export { FilesystemSkill, filesystemSkill } from './filesystem';
export { ShellSkill, shellSkill } from './shell';
export { GitSkill, gitSkill } from './git';
export { BrowserSkill, browserSkill } from './browser';
export { WebSearchSkill, websearchSkill } from './websearch';
export { DockerSkill, dockerSkill } from './docker';

import { getSkillRegistry } from './registry';
import { filesystemSkill } from './filesystem';
import { shellSkill } from './shell';
import { gitSkill } from './git';
import { browserSkill } from './browser';
import { websearchSkill } from './websearch';
import { dockerSkill } from './docker';

/**
 * Register all built-in skills
 */
export async function registerBuiltinSkills(): Promise<void> {
  const registry = getSkillRegistry();

  await registry.register(filesystemSkill);
  await registry.register(shellSkill);
  await registry.register(gitSkill);
  await registry.register(browserSkill);
  await registry.register(websearchSkill);
  await registry.register(dockerSkill);
}
