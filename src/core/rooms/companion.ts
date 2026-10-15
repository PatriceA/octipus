import type { CompanionIdentity } from '@/shared/companion';
import { mentionsCompanion } from '@/shared/companion';
import { resolvePersonaForUser } from '@/core/personas/resolver';
import { displayNames } from '@/core/session-history';

/** Expose only public attribution, never persona instructions or personal facts. */
export async function companionIdentity(userId: string): Promise<CompanionIdentity> {
  const [persona, names] = await Promise.all([resolvePersonaForUser(userId), displayNames([userId])]);
  return { ownerUserId: userId, ownerName: names.get(userId) ?? 'A member', name: persona.name, ...(persona.appearance ? { appearance: persona.appearance } : {}) };
}

/** A bare name colliding with a member belongs to the member. The Ask toggle disambiguates. */
export async function mentionsOwnCompanion(content: string, identity: CompanionIdentity, spaceId: string): Promise<boolean> {
  if (!mentionsCompanion(content, identity.name)) return false;
  const { spaceMemberByUsername } = await import('./service');
  const members = await spaceMemberByUsername(spaceId, [identity.name.toLowerCase()]);
  return !members.some((member) => member.kind === 'local');
}
