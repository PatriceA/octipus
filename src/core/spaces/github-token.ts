/**
 * A space's GitHub token (docs/plans/coworking-spec.md §9.5).
 *
 * An owner pastes a GitHub token (fine-grained, limited to the team's
 * repositories) once; the space's agent then uses it for every member who
 * may run it — the GitHub tool hands it to `runGh` as `opts.token`, and a
 * space run's tool home (`src/security/space-tool-env.ts`) seeds `gh` and
 * git with it. It is a space secret (`vault.scope = 'space'`), read and
 * written only through `spaceRepos(principal).secrets` after a membership
 * check, and never through `{{secret:}}`, so a turn cannot route it into a
 * shell command or an HTTP request.
 */
import { getDb } from '@/db/postgres';
import { memberPrincipal, spaceRepos } from '@/db/repositories/space';
import type { Principal } from '@/security/principal';
import { requireCan, SpaceError } from '@/security/space-access';
import { auditActor, getMembership, isSpaceArchived, type SpaceActor, writeSpaceAudit } from './service';

/**
 * The secret name of the token inside a space. It was named when the token
 * was one of the space's connectors (a framework since removed); existing
 * spaces store it under this name, so it is kept.
 */
export const SPACE_GITHUB_TOKEN_SECRET = 'connector_github_access_token';

export interface SpaceGithubView {
  connected: boolean;
  /** The owner who stored it. */
  connectedBy: string | null;
  connectedAt: string | null;
}

/** Whether the space has a GitHub token, and who stored it (any member but a guest reads). */
export async function getSpaceGithub(actor: SpaceActor, workspaceId: string): Promise<SpaceGithubView> {
  const principal = await memberPrincipal(actor.userId, workspaceId);
  const row = (await spaceRepos(principal).secrets.list()).find((s) => s.name === SPACE_GITHUB_TOKEN_SECRET);
  if (!row) return { connected: false, connectedBy: null, connectedAt: null };
  const { displayNames } = await import('@/core/session-history');
  const names = await displayNames([row.storedBy]);
  return { connected: true, connectedBy: names.get(row.storedBy) ?? null, connectedAt: row.updatedAt.toISOString() };
}

/** Owners only, space open; `not_found` for a stranger. */
async function requireOwner(actor: SpaceActor, workspaceId: string): Promise<Principal> {
  requireCan(await getMembership(actor.userId, workspaceId), 'manage_space');
  if (await isSpaceArchived(workspaceId)) throw new SpaceError('archived', 'This space is archived');
  return memberPrincipal(actor.userId, workspaceId);
}

async function audit(actor: SpaceActor, workspaceId: string, connected: boolean): Promise<void> {
  await writeSpaceAudit(getDb(), {
    ...auditActor(actor),
    action: 'space_updated',
    workspaceId,
    resourceType: 'space_github',
    resourceId: 'github',
    details: { github: true, connected },
  });
}

/** Store the space's GitHub token (owners), replacing the previous one. */
export async function setSpaceGithubToken(actor: SpaceActor, workspaceId: string, token: string): Promise<{ connected: true }> {
  const principal = await requireOwner(actor, workspaceId);
  const value = token.trim();
  if (!value) throw new SpaceError('invalid_input', 'Paste a GitHub token');
  if (/\s/.test(value) || value.length > 400) throw new SpaceError('invalid_input', 'That does not look like a GitHub token');
  await spaceRepos(principal).secrets.write(SPACE_GITHUB_TOKEN_SECRET, value, 'api_key');
  await audit(actor, workspaceId, true);
  return { connected: true };
}

/** Remove the space's GitHub token (owners). */
export async function removeSpaceGithubToken(actor: SpaceActor, workspaceId: string): Promise<{ removed: number }> {
  const principal = await requireOwner(actor, workspaceId);
  const removed = await spaceRepos(principal).secrets.remove([SPACE_GITHUB_TOKEN_SECRET]);
  if (removed > 0) await audit(actor, workspaceId, false);
  return { removed };
}

/** The space's GitHub token for `runGh`, or null when the space has none. */
export function spaceGithubToken(principal: Principal): Promise<string | null> {
  return spaceRepos(principal).secrets.read(SPACE_GITHUB_TOKEN_SECRET);
}
