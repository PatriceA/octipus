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
import { coreLogger } from '@/utils/logger';

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
