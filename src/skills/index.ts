export { BaseSkill, createParameterSchema, type SkillContext, type ToolExecutionOptions } from './base-skill';
export { SkillRegistry, getSkillRegistry, type SkillRegistryOptions } from './registry';

// Built-in skills
export { FilesystemSkill, filesystemSkill } from './filesystem';
export { ShellSkill, shellSkill } from './shell';
export { GitSkill, gitSkill } from './git';
export { BrowserSkill, browserSkill } from './browser';
export { WebSearchSkill, websearchSkill } from './websearch';
export { DockerSkill, dockerSkill } from './docker';
export { GitHubSkill, githubSkill } from './github';
export { GitLabSkill, gitlabSkill } from './gitlab';
export { GoogleWorkspaceSkill, googleWorkspaceSkill } from './google-workspace';
export { Microsoft365Skill, microsoft365Skill } from './microsoft365';

import { getSkillRegistry } from './registry';
import { filesystemSkill } from './filesystem';
import { shellSkill } from './shell';
import { gitSkill } from './git';
import { browserSkill } from './browser';
import { websearchSkill } from './websearch';
import { dockerSkill } from './docker';
import { githubSkill } from './github';
import { gitlabSkill } from './gitlab';
import { googleWorkspaceSkill } from './google-workspace';
import { microsoft365Skill } from './microsoft365';

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
  await registry.register(githubSkill);
  await registry.register(gitlabSkill);
  await registry.register(googleWorkspaceSkill);
  await registry.register(microsoft365Skill);
}
