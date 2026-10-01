import { resolveUserId } from '@/core/gateway/resolve-user';
import { skillRepository, type SkillUpdate } from '@/db/repositories/skill-repository';
import { userRepository } from '@/db/repositories/user-repository';
import { isExternalSkillId } from './external-loader';

export class SkillUpdateError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 403 | 404) { super(message); }
}

const textFields = ['name', 'description', 'category', 'content'] as const;
const arrayFields = ['principles', 'bestPractices', 'antiPatterns', 'frameworks'] as const;

/** Shared by the agent tool and REST/MCP, preserving omitted fields and skill identity. */
export async function updateSkill(skillId: unknown, fields: Record<string, unknown>, userId: string) {
  if (!userId) throw new SkillUpdateError('Not authenticated', 401);
  if (typeof skillId !== 'string' || !skillId.trim()) throw new SkillUpdateError('skill_id must be a non-empty string', 400);
  const ownerId = await resolveUserId(userId);
  const user = await userRepository.findById(ownerId);
  if (!user) throw new SkillUpdateError('Not authenticated', 401);
  if (isExternalSkillId(skillId)) throw new SkillUpdateError('Mounted skills are read-only in Octipus. Update the source SKILL.md and use Reload mounted skills.', 400);
  const existing = await skillRepository.findById(skillId);
  if (!existing) throw new SkillUpdateError('Skill not found', 404);
  if (!existing.isSystem && !user.isAdmin && existing.userId !== ownerId) throw new SkillUpdateError('Not authorized to update this skill', 403);
  const patch: SkillUpdate = {};
  for (const key of textFields) {
    if (fields[key] === undefined) continue;
    if (typeof fields[key] !== 'string') throw new SkillUpdateError(`${key} must be a string`, 400);
    if (key !== 'content' && !fields[key].trim()) throw new SkillUpdateError(`${key} must not be empty`, 400);
    patch[key] = fields[key];
  }
  for (const key of arrayFields) {
    if (fields[key] === undefined) continue;
    const value = fields[key];
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new SkillUpdateError(`${key} must be an array of strings`, 400);
    patch[key] = value;
  }
  if (!Object.keys(patch).length) throw new SkillUpdateError('Provide at least one skill field to update', 400);
  const updated = await skillRepository.update(skillId, patch);
  if (!updated) throw new SkillUpdateError('Skill not found', 404);
  return updated;
}
