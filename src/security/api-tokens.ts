/**
 * API tokens — Phase 2a multi-user.
 *
 * Personal access tokens for non-browser clients. The plaintext is
 * shown to the user exactly ONCE at creation; only the SHA-256 hash
 * is persisted. Validation hashes the incoming Bearer token, looks
 * the hash up in `api_tokens` (unique-indexed), enforces revocation
 * + expiry, and returns the owning user.
 *
 * The issuance flow is intentionally similar to GitHub's PAT shape so
 * the UX is familiar:
 *   - 32 random bytes encoded base64url
 *   - prefixed with `octi_` (constant) so tokens are recognizable in
 *     logs, grep, and accidental commits to source control
 *   - server stores `(prefix, token_hash)` — the prefix is the first
 *     8 plaintext characters and lets the list endpoint show a
 *     handle without exposing the full secret
 *
 * The hash is plain SHA-256, not bcrypt/argon2. That's deliberate:
 *   - 32 bytes of randomness means dictionary attacks are infeasible
 *     even with no key-stretching, so the slow-hash benefits don't
 *     apply
 *   - SHA-256 is fast enough to validate on every API request
 *     without becoming a hot path
 *   - bcrypt would force a per-token timing-attack mitigation since
 *     we can't use the hash as an indexed lookup key
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb } from '@/db/postgres';
import { auditRepository } from '@/db/repositories/audit-repository';
import { type ApiToken, type ApiTokenSummary, apiTokens } from '@/db/schema/api-tokens';
import { securityLogger } from '@/utils/logger';

const TOKEN_PREFIX = 'octi_';
/** Length of the random component in bytes (43 base64url chars). */
const TOKEN_BYTES = 32;
/** Public prefix used for display in the list view. */
const DISPLAY_PREFIX_LEN = 12;

/** A token plaintext + the row metadata. The plaintext is returned
 *  exactly once — at creation time — and never read back from the DB. */
export interface IssuedApiToken {
  /** Plaintext bearer value. Show once and never again. */
  plaintext: string;
  /** Persisted row metadata (no hash, no plaintext). */
  summary: ApiTokenSummary;
}

export interface IssueOptions {
  name: string;
  scopes?: readonly string[];
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
}

/**
 * Generate a fresh token plaintext. base64url-encoded 32 random bytes
 * (43 chars) with the `octi_` prefix. Total length is 48 chars.
 */
export function generateTokenPlaintext(): string {
  const raw = randomBytes(TOKEN_BYTES).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${TOKEN_PREFIX}${raw}`;
}

/**
 * SHA-256 hash of the plaintext, hex-encoded. Used as the unique key
 * for validation lookups and as the stored value.
 */
export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** Constant-time equality check for two hex strings. */
function safeHashEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Cheap shape check before hitting the DB. Lets us short-circuit
 * non-token Bearer values (legacy session ids, MASTER_KEY, etc.)
 * without paying for a SQL roundtrip.
 */
export function looksLikeApiToken(value: string): boolean {
  if (!value.startsWith(TOKEN_PREFIX)) return false;
  // 32 bytes base64url is 43 chars. Allow a small range for safety.
  const tail = value.slice(TOKEN_PREFIX.length);
  return tail.length >= 32 && /^[A-Za-z0-9_-]+$/.test(tail);
}

function rowToSummary(row: ApiToken): ApiTokenSummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes ?? [],
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

export class ApiTokenManager {
  private get db() { return getDb(); }

  /**
   * Issue a new token for the given user. Returns the plaintext
   * exactly once — the caller MUST surface it to the user immediately
   * and never log/store it. Subsequent reads of the row return only
   * the summary (no plaintext, no hash).
   */
  async issue(userId: string, options: IssueOptions): Promise<IssuedApiToken> {
    const plaintext = generateTokenPlaintext();
    const tokenHash = hashToken(plaintext);
    const prefix = plaintext.slice(0, DISPLAY_PREFIX_LEN);

    const [row] = await this.db.insert(apiTokens).values({
      userId,
      name: options.name,
      tokenHash,
      prefix,
      scopes: options.scopes ? Array.from(options.scopes) : [],
      expiresAt: options.expiresAt ?? null,
      metadata: options.metadata ?? {},
    }).returning();

    await auditRepository.log({
      userId,
      action: 'credential_created',
      resourceType: 'api_token',
      resourceId: row.id,
      details: { name: options.name, prefix },
    });

    securityLogger.info({ userId, tokenId: row.id, name: options.name }, 'API token issued');

    return { plaintext, summary: rowToSummary(row) };
  }

  /**
   * Validate a Bearer token against the api_tokens table. Returns the
   * owning user-id on success; null when the token is unknown,
   * revoked, expired, or malformed.
   *
   * On a successful validation `last_used_at` is updated. The update
   * is best-effort — failures are logged but never propagate so a
   * transient DB hiccup can't block authentication.
   */
  async validate(plaintext: string): Promise<{ userId: string; tokenId: string } | null> {
    if (!looksLikeApiToken(plaintext)) return null;
    const tokenHash = hashToken(plaintext);

    const [row] = await this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, tokenHash))
      .limit(1);

    if (!row) return null;
    // Defense-in-depth — the indexed lookup found a match, but verify
    // hash equality with constant-time compare just in case.
    if (!safeHashEqual(row.tokenHash, tokenHash)) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt < new Date()) return null;

    // Record usage. Don't await — let it run in the background.
    this.db
      .update(apiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiTokens.id, row.id))
      .catch((err: unknown) => {
        securityLogger.warn({ err, tokenId: row.id }, 'Failed to update last_used_at');
      });

    return { userId: row.userId, tokenId: row.id };
  }

  /**
   * List the principal's own tokens (active + revoked). Returns
   * summaries only — no plaintext, no hash. Order: most recently
   * created first.
   */
  async listForUser(userId: string): Promise<ApiTokenSummary[]> {
    const rows = await this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.userId, userId))
      .orderBy(desc(apiTokens.createdAt));
    return rows.map(rowToSummary);
  }

  /**
   * Revoke a single token. Cross-tenant attempts (caller's userId
   * doesn't own the row) are silent no-ops returning false — same
   * shape as "doesn't exist or already revoked", to prevent ID
   * enumeration. Pass `{ admin: true }` to override.
   */
  async revoke(
    userId: string,
    tokenId: string,
    opts?: { admin?: boolean },
  ): Promise<boolean> {
    const filters = [
      eq(apiTokens.id, tokenId),
      isNull(apiTokens.revokedAt),
    ];
    if (!opts?.admin) filters.push(eq(apiTokens.userId, userId));

    const result = await this.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(...filters))
      .returning();

    if (result.length === 0) return false;

    await auditRepository.log({
      userId,
      action: 'credential_deleted',
      resourceType: 'api_token',
      resourceId: tokenId,
      details: { name: result[0].name, prefix: result[0].prefix, admin: !!opts?.admin },
    });

    securityLogger.info({ userId, tokenId }, 'API token revoked');
    return true;
  }

  /** Active token count for the user (excluding revoked + expired). */
  async countActive(userId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(apiTokens)
      .where(and(
        eq(apiTokens.userId, userId),
        isNull(apiTokens.revokedAt),
      ));
    return rows[0]?.count ?? 0;
  }
}

let instance: ApiTokenManager | null = null;

export function getApiTokenManager(): ApiTokenManager {
  if (!instance) instance = new ApiTokenManager();
  return instance;
}

/** Test-only reset hook. */
export function _resetApiTokenManagerForTests(): void {
  instance = null;
}
