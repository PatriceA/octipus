import { realpath, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { getSkillRegistry } from './registry';
import { WorkspaceFS } from '@/security/workspace-fs';

/** Resolve only a registered, user-visible directory skill, never a caller-supplied root. */
export async function skillResourceRoot(skillId: string, userId: string): Promise<string> {
  const registry = getSkillRegistry();
  const skill = await registry.get(skillId, userId);
  if (!skill) throw new Error('Skill is not available to this user.');
  const external = registry.getExternalSkills().find(entry => entry.id === skill.id);
  const source = external?.sources[0]?.path;
  if (!source || basename(source).toLowerCase() !== 'skill.md') {
    throw new Error('This skill has no directory bundle of supporting files.');
  }
  return realpath(dirname(source));
}

export function resolveSkillResource(root: string, resource: string): string {
  if (isAbsolute(resource) || resource.split(/[\\/]/).some(part => part.startsWith('.') && part !== '.')) {
    throw new Error('Use a relative skill path without hidden files or parent traversal.');
  }
  return WorkspaceFS.withRoot(root).resolve(resolve(root, resource));
}

export async function readSkillResource(skillId: string, resource: string, userId: string): Promise<unknown> {
  const root = await skillResourceRoot(skillId, userId);
  const path = resolveSkillResource(root, resource);
  const info = await stat(path);
  if (info.isDirectory()) {
    const entries = await readdir(path, { withFileTypes: true });
    const visible = entries.filter(entry => !entry.name.startsWith('.'));
    return { path: resource, entries: visible.slice(0, 1000).map(entry => ({ name: entry.name, directory: entry.isDirectory() })), truncated: visible.length > 1000 };
  }
  if (!info.isFile() || info.size > 256 * 1024) throw new Error('Skill resource must be a text file of at most 256 KiB.');
  const content = await readFile(path, 'utf8');
  if (content.includes('\0')) throw new Error('Binary skill resources cannot be read as text.');
  return { path: resource, content };
}
