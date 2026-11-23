/**
 * Live `artifact_token` viewers (gateway connections of an embed page).
 *
 * A viewer's token is checked once, at gateway auth, and stays valid until its
 * `exp`. When the artifact is deleted or its visibility changes, the access it
 * was minted under may be gone, so `revokeArtifactViewers` closes every viewer
 * connection of that artifact and refuses the tokens issued before that moment
 * (a reconnect with one fails; the page has to be reloaded, which re-checks
 * access and mints a new token). The gateway enforces token expiry with a
 * timer per connection (ConnectionManager).
 *
 * Process-local, like the gateway connections themselves: tokens live minutes,
 * so a cutoff only has to outlast them.
 */
import type { Artifact } from '@/db/schema/artifacts';
import { coreLogger } from '@/utils/logger';
import { type ArtifactTokenPayload, verifyArtifactToken } from './token';

/** Close code for viewer connections whose artifact access changed. */
export const ARTIFACT_ACCESS_CLOSE_CODE = 4003;

/** Cutoffs older than this are dropped: every token issued before them has expired. */
const CUTOFF_RETENTION_SECONDS = 24 * 60 * 60;

/** artifact id → seconds; tokens issued at or before it are refused. */
const revokedAt = new Map<string, number>();

/** Whether a token for `artifactId` issued at `iat` (seconds) was revoked. */
export function isArtifactTokenRevoked(artifactId: string, iat: number): boolean {
  const cutoff = revokedAt.get(artifactId);
  return cutoff !== undefined && iat <= cutoff;
}

/**
 * The artifact was deleted or its visibility changed: refuse the tokens issued
 * so far and close every viewer connection of it.
 */
export async function revokeArtifactViewers(artifactId: string, reason: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  for (const [id, cutoff] of revokedAt) {
    if (cutoff < now - CUTOFF_RETENTION_SECONDS) revokedAt.delete(id);
  }
  revokedAt.set(artifactId, now);

  // Lazy: the hub pulls the whole gateway in, which the repository callers of
  // this module must not load at import time.
  const { getGatewayHub } = await import('@/core/gateway/hub');
  const closed = getGatewayHub().connectionManager.closeArtifactViewers(artifactId, ARTIFACT_ACCESS_CLOSE_CODE, reason);
  if (closed > 0) coreLogger.info({ artifactId, closed, reason }, 'Closed artifact viewer connections');
}

/**
 * The one check an `artifact_token` passes before it opens anything — the
 * gateway sign-in and the embed's data reads both go through it. The token
 * must be signed for this artifact, unexpired and read-only; issued after the
 * artifact's last access change; for a live artifact still in the workspace
 * it was minted in; and, when it was minted from a signed share link, that
 * link must still be live (revoking a link ends what it opened).
 */
export async function authorizeArtifactViewerToken(
  token: string,
  artifactId: string,
): Promise<{ payload: ArtifactTokenPayload; artifact: Artifact } | null> {
  const payload = verifyArtifactToken(token, { aid: artifactId });
  if (!payload || isArtifactTokenRevoked(artifactId, payload.iat)) return null;
  const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
  const artifact = await artifactsRepository.getById(artifactId);
  if (!artifact || artifact.workspaceId !== payload.wid) return null;
  if (payload.slid !== undefined) {
    const link = await artifactsRepository.getShareLink(payload.slid);
    if (!link || link.artifactId !== artifactId || link.revokedAt != null || link.expiresAt.getTime() < Date.now()) {
      return null;
    }
  }
  return { payload, artifact };
}
