import { CHAT_INBOX_RESOURCE } from '@/shared/chat-gateway';
import type { ConnectionContext } from './protocol';

/**
 * May this connection subscribe to `resource`? The one gate in front of
 * `ConnectionContext.resources`, so the one place resource delivery is
 * authorized. Unknown resource kinds are refused.
 *
 * - `artifact:<id>` — an `artifact_token` connection gets its own artifact
 *   and nothing else; a signed-in user gets an artifact of a personal
 *   workspace they own, or of a space they are a member of (not `private`
 *   to another member).
 * - `chat:inbox` (`CHAT_INBOX_RESOURCE`) — any signed-in user connection: it
 *   says "this connection shows the chat page", so an in-app delivery to the
 *   user counts as delivered. It carries nobody else's data.
 */
export async function canSubscribeToResource(ctx: ConnectionContext, resource: string): Promise<boolean> {
  const sep = resource.indexOf(':');
  const kind = resource.slice(0, sep);
  const id = resource.slice(sep + 1);
  if (sep <= 0 || !id) return false;

  if (ctx.artifactId !== undefined) {
    return kind === 'artifact' && id === ctx.artifactId;
  }

  switch (kind) {
    case 'artifact':
      return userMayReadArtifact(ctx.userId, id);
    case 'chat':
      return resource === CHAT_INBOX_RESOURCE;
    default:
      return false;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function userMayReadArtifact(userId: string, artifactId: string): Promise<boolean> {
  // Not a uuid: no such artifact (and Postgres would reject the comparison).
  if (!UUID_RE.test(artifactId)) return false;
  const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
  const artifact = await artifactsRepository.getById(artifactId);
  if (!artifact) return false;
  const { getDb } = await import('@/db');
  const { workspaces } = await import('@/db/schema/organizations');
  const { eq } = await import('drizzle-orm');
  const [ws] = await getDb()
    .select({ userId: workspaces.userId, kind: workspaces.kind })
    .from(workspaces)
    .where(eq(workspaces.id, artifact.workspaceId))
    .limit(1);
  if (!ws) return false;
  if (ws.kind === 'personal') return ws.userId === userId;
  // A space (no owning user, D2): its members read it — the membership read
  // now (D5), guests not until their scopes exist — and `private` stays the
  // creator's, as on the REST routes.
  const { getMembership } = await import('@/core/spaces/service');
  const membership = await getMembership(userId, artifact.workspaceId);
  if (!membership || membership.role === 'guest') return false;
  return artifact.visibility !== 'private' || artifact.createdByUserId === userId;
}
