import { CHAT_INBOX_RESOURCE } from '@/shared/chat-gateway';
import type { ConnectionContext } from './protocol';

/**
 * May this connection subscribe to `resource`? The one gate in front of
 * `ConnectionContext.resources`, so the one place resource delivery is
 * authorized. Unknown resource kinds are refused.
 *
 * - `artifact:<id>` — an `artifact_token` connection gets its own artifact
 *   and nothing else; a signed-in user gets an artifact whose workspace they
 *   own (members join in with shared spaces).
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
      return userOwnsArtifact(ctx.userId, id);
    case 'chat':
      return resource === CHAT_INBOX_RESOURCE;
    default:
      return false;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function userOwnsArtifact(userId: string, artifactId: string): Promise<boolean> {
  // Not a uuid: no such artifact (and Postgres would reject the comparison).
  if (!UUID_RE.test(artifactId)) return false;
  const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
  const artifact = await artifactsRepository.getById(artifactId);
  if (!artifact) return false;
  const { getDb } = await import('@/db');
  const { workspaces } = await import('@/db/schema/organizations');
  const { eq } = await import('drizzle-orm');
  const [ws] = await getDb()
    .select({ userId: workspaces.userId })
    .from(workspaces)
    .where(eq(workspaces.id, artifact.workspaceId))
    .limit(1);
  return ws?.userId === userId;
}
