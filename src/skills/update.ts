import { skillRepository, type SkillUpdate } from '@/db/repositories/skill-repository';
import { userRepository } from '@/db/repositories/user-repository';
import { type Principal, requireRealUserId } from '@/security/principal';
import { isExternalSkillId } from './external-loader';

export class SkillUpdateError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 403 | 404) { super(message); }
}

const textFields = ['name', 'description', 'category', 'content'] as const;
const arrayFields = ['principles', 'bestPractices', 'antiPatterns', 'frameworks'] as const;

/** The MCP server's session when it signs in with a password (LOGIN_DEVICE_NAME in mcp-server/src/auth.ts, via /api/auth/login). */
const MCP_SERVER_SESSION_AGENT = 'Mobile: Octipus MCP server';

/**
 * Whether a request is a person writing in their own name — the only kind of
 * write that stamps `ownerEditedAt` and so locks a skill against learning
 * patches (docs/SESSION-LEARNING.md#the-owner-edit-lock):
 *  - a `user` principal (not `service`, `system` or `anonymous`),
 *  - on a login session — the web or mobile app. A request on an API token
 *    has no session: scripts, and CLI agents, whose MCP bridge calls the API
 *    with one;
 *  - not the MCP server's own password login, which is an agent too;
 *  - not an admin impersonating the user (`actorUserId`).
 * Whose skill it is is checked by the caller: an admin editing another
 * user's skill is not that owner's edit.
 */
export function isInPersonWrite(principal: Pick<Principal, 'kind' | 'actorUserId'>, session: { userAgent?: string } | null): boolean {
  return principal.kind === 'user' && !principal.actorUserId && session !== null && session.userAgent !== MCP_SERVER_SESSION_AGENT;
}

/**
 * Shared by the agent tool and REST/MCP, preserving omitted fields and skill identity.
 * `inPerson` (see `isInPersonWrite`): when the caller also owns the skill,
 * the write stamps `ownerEditedAt`. The in-process agent tool passes false.
 */
export async function updateSkill(skillId: unknown, fields: Record<string, unknown>, userId: string, { inPerson = false }: { inPerson?: boolean } = {}) {
  if (!userId) throw new SkillUpdateError('Not authenticated', 401);
  if (typeof skillId !== 'string' || !skillId.trim()) throw new SkillUpdateError('skill_id must be a non-empty string', 400);
  const ownerId = requireRealUserId(userId);
  const user = await userRepository.findById(ownerId);
  if (!user) throw new SkillUpdateError('Not authenticated', 401);
  if (isExternalSkillId(skillId)) throw new SkillUpdateError('Mounted skills are read-only in Octipus. Update the source SKILL.md and use Reload mounted skills.', 400);
  const existing = await skillRepository.findById(skillId);
  if (!existing) throw new SkillUpdateError('Skill not found', 404);
  // A system skill is shared by every user: only an administrator edits it.
  // Any other skill only by its owner (or an administrator).
  if (!user.isAdmin && (existing.isSystem || existing.userId !== ownerId)) throw new SkillUpdateError('Not authorized to update this skill', 403);
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
  if (inPerson && existing.userId === ownerId) patch.ownerEditedAt = new Date();
  const updated = await skillRepository.update(skillId, patch);
  if (!updated) throw new SkillUpdateError('Skill not found', 404);
  return updated;
}
