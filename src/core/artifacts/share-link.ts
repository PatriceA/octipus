/**
 * Signed share-link mint/verify. Raw token only ever leaves the server in the
 * mint response; only `sha256(token)` persists. Revocation is immediate —
 * `revokedAt` is checked on every verify.
 */

import { artifactsRepository } from '@/db/repositories/artifacts-repository';
import { generateToken, sha256 } from '@/utils/crypto';
import { coreLogger } from '@/utils/logger';

export interface MintShareLinkInput {
  artifactId: string;
  createdByUserId: string;
  /** Lifetime seconds. Capped at 30 days. */
  ttlSeconds: number;
  scope?: Record<string, unknown>;
}

export interface MintedShareLink {
  id: string;
  token: string;
  expiresAt: Date;
}

const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function mintShareLink(input: MintShareLinkInput): Promise<MintedShareLink> {
  const ttl = Math.min(Math.max(input.ttlSeconds, 60), MAX_TTL_SECONDS);
  const token = generateToken(32);
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + ttl * 1000);

  const link = await artifactsRepository.createShareLink({
    artifactId: input.artifactId,
    tokenHash,
    expiresAt,
    createdByUserId: input.createdByUserId,
    scopeJson: input.scope ?? {},
  });

  // Log only the hash + last 4 chars of token (per anti-pattern guard).
  coreLogger.info(
    { artifactId: input.artifactId, linkId: link.id, tokenLast4: token.slice(-4), tokenHash },
    'artifact.share_link.minted',
  );

  return { id: link.id, token, expiresAt };
}

export interface VerifiedShareLink {
  artifactId: string;
  scope: Record<string, unknown>;
  shareLinkId: string;
}

export async function verifyShareLinkToken(token: string): Promise<VerifiedShareLink | null> {
  if (!token) return null;
  const tokenHash = sha256(token);
  const link = await artifactsRepository.findShareLinkByHash(tokenHash);
  if (!link) return null;
  if (link.revokedAt != null) return null;
  if (link.expiresAt.getTime() < Date.now()) return null;
  return {
    artifactId: link.artifactId,
    scope: (link.scopeJson ?? {}) as Record<string, unknown>,
    shareLinkId: link.id,
  };
}
