/**
 * Channel-binding manager — Phase 2d multi-user.
 *
 * Owns the `(channel_type, external_id) → user` mapping. Channel
 * adapters call `findUserByExternalId` to resolve an incoming
 * Telegram chat_id / Slack user_id / etc. into a real Octipus user.
 * If the lookup misses, the adapter calls `createPendingLink` to mint
 * a one-time 6-character code and replies to the channel with a
 * deep-link to the web "Link account" page; the user logs in there
 * and POSTs the code to `/api/auth/channel-bindings/redeem`.
 *
 * Lookup precedence (Phase 2d transition):
 *   1. `channel_identities` table (canonical going forward).
 *   2. Legacy `users.channelBindings` JSONB column. When found there
 *      we opportunistically backfill into `channel_identities` so the
 *      next lookup is fast.
 *
 * Code format: 6-char uppercase alphanumeric, picked from
 * `ABCDEFGHJKMNPQRSTUVWXYZ23456789` — no `0/O`, `1/I/L`, no padding
 * chars — so a user typing it on a mobile keyboard has minimal
 * ambiguity.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import { getDb } from '@/db/postgres';
import { auditRepository } from '@/db/repositories/audit-repository';
import {
  type ChannelIdentity,
  channelIdentities,
  type ChannelLinkCode,
  channelLinkCodes,
  type NewChannelIdentity,
} from '@/db/schema/channel-identities';
import { type ChannelBinding, users } from '@/db/schema/users';
import { securityLogger } from '@/utils/logger';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const LINK_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export type ChannelType = 'telegram' | 'slack' | 'whatsapp' | 'teams' | 'webchat' | 'discord' | (string & {});

export interface PendingLink {
  code: string;
  channelType: ChannelType;
  externalId: string;
  expiresAt: Date;
}

/** Random 6-character code from the unambiguous alphabet. */
export function generateLinkCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export class ChannelBindingManager {
  private get db() { return getDb(); }

  /**
   * Resolve a channel external id to a user. Checks the new
   * `channel_identities` table first; on a miss falls back to the
   * legacy `users.channelBindings` JSONB column and opportunistically
   * backfills into the new table so the next lookup is fast.
   */
  async findUserByExternalId(channelType: ChannelType, externalId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ userId: channelIdentities.userId })
      .from(channelIdentities)
      .where(and(
        eq(channelIdentities.channelType, channelType),
        eq(channelIdentities.externalId, externalId),
      ))
      .limit(1);
    if (row) return row.userId;

    // Legacy fallback: scan the JSONB column. This is O(N) over the
    // user table — acceptable during the transition window because
    // the new table catches every binding on first read.
    const allUsers = await this.db.select({
      id: users.id, channelBindings: users.channelBindings,
    }).from(users);

    for (const u of allUsers) {
      let bindings = u.channelBindings as ChannelBinding[] | string | null;
      if (typeof bindings === 'string') {
        try { bindings = JSON.parse(bindings); } catch { bindings = []; }
      }
      if (!Array.isArray(bindings)) continue;
      const match = bindings.find((b) => b.channelType === channelType && b.channelUserId === externalId);
      if (!match) continue;

      // Opportunistic backfill — best-effort, don't fail the lookup.
      try {
        await this.db.insert(channelIdentities).values({
          userId: u.id,
          channelType,
          externalId,
          externalHandle: match.channelUserName ?? null,
          verifiedAt: match.isVerified ? new Date() : null,
        }).onConflictDoNothing();
      } catch (err) {
        securityLogger.warn({ err, channelType, externalId }, 'Backfill into channel_identities failed');
      }

      return u.id;
    }

    return null;
  }

  /**
   * Create a pending one-time link code. Same `(channel_type,
   * external_id)` pair issued more than once produces a fresh code
   * each time — old codes stay in the table but expire on TTL.
   */
  async createPendingLink(channelType: ChannelType, externalId: string, externalHandle?: string): Promise<PendingLink> {
    // Try a few times in the (extremely unlikely) event of a code collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateLinkCode();
      const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
      try {
        await this.db.insert(channelLinkCodes).values({
          code,
          channelType,
          externalId,
          externalHandle: externalHandle ?? null,
          expiresAt,
        });
        securityLogger.info({ code, channelType, externalId }, 'Channel link code issued');
        return { code, channelType, externalId, expiresAt };
      } catch (err) {
        // Unique violation on `code` — try again with a fresh code.
        if ((err as { code?: string }).code === '23505') continue;
        throw err;
      }
    }
    throw new Error('Could not generate a unique link code after 5 attempts');
  }

  /**
   * Redeem a pending link code on behalf of an authenticated user.
   * Creates the channel_identities row, marks the code redeemed, and
   * writes an audit entry. Idempotent: re-redeeming a code that's
   * already been redeemed by the same user is a no-op success;
   * cross-user redemption of an already-claimed code is rejected.
   */
  async redeem(userId: string, code: string): Promise<{ ok: true; binding: ChannelIdentity } | { ok: false; reason: string }> {
    const upper = code.trim().toUpperCase();
    const [row] = await this.db
      .select()
      .from(channelLinkCodes)
      .where(eq(channelLinkCodes.code, upper))
      .limit(1);

    if (!row) return { ok: false, reason: 'unknown_code' };
    if (row.expiresAt < new Date()) return { ok: false, reason: 'expired' };
    if (row.redeemedAt) {
      // Idempotency window for the same user; otherwise reject.
      if (row.redeemedByUserId === userId) {
        const [existing] = await this.db
          .select()
          .from(channelIdentities)
          .where(and(
            eq(channelIdentities.channelType, row.channelType),
            eq(channelIdentities.externalId, row.externalId),
          ))
          .limit(1);
        if (existing) return { ok: true, binding: existing };
      }
      return { ok: false, reason: 'already_redeemed' };
    }

    // Insert the binding (idempotent on the unique
    // `(channel_type, external_id)` index — a row may already exist
    // from a previous backfill).
    const insert: NewChannelIdentity = {
      userId,
      channelType: row.channelType,
      externalId: row.externalId,
      externalHandle: row.externalHandle ?? null,
      verifiedAt: new Date(),
    };
    let binding: ChannelIdentity;
    try {
      const [created] = await this.db.insert(channelIdentities).values(insert).returning();
      binding = created;
    } catch (err) {
      // Unique violation — fetch the existing row.
      if ((err as { code?: string }).code === '23505') {
        const [existing] = await this.db
          .select()
          .from(channelIdentities)
          .where(and(
            eq(channelIdentities.channelType, row.channelType),
            eq(channelIdentities.externalId, row.externalId),
          ))
          .limit(1);
        if (!existing) throw err;
        // If the existing row belongs to another user, refuse — never
        // silently re-target someone else's binding.
        if (existing.userId !== userId) return { ok: false, reason: 'already_bound_to_another_user' };
        binding = existing;
      } else {
        throw err;
      }
    }

    await this.db
      .update(channelLinkCodes)
      .set({ redeemedAt: new Date(), redeemedByUserId: userId })
      .where(eq(channelLinkCodes.id, row.id));

    await auditRepository.log({
      userId,
      action: 'credential_created',
      resourceType: 'channel_binding',
      resourceId: binding.id,
      details: { channelType: row.channelType, externalId: row.externalId },
    });

    securityLogger.info({ userId, channelType: row.channelType, externalId: row.externalId }, 'Channel binding redeemed');
    return { ok: true, binding };
  }

  /** List all bindings owned by a user. */
  async listForUser(userId: string): Promise<ChannelIdentity[]> {
    return this.db
      .select()
      .from(channelIdentities)
      .where(eq(channelIdentities.userId, userId));
  }

  /**
   * Unbind a channel identity. Cross-tenant attempts return false
   * silently (404 from the route layer). Pass `{ admin: true }` to
   * override for the future admin console.
   */
  async unbind(
    userId: string,
    channelType: ChannelType,
    externalId: string,
    opts?: { admin?: boolean },
  ): Promise<boolean> {
    const filters = [
      eq(channelIdentities.channelType, channelType),
      eq(channelIdentities.externalId, externalId),
    ];
    if (!opts?.admin) filters.push(eq(channelIdentities.userId, userId));

    const result = await this.db
      .delete(channelIdentities)
      .where(and(...filters))
      .returning();

    if (result.length === 0) return false;

    await auditRepository.log({
      userId,
      action: 'credential_deleted',
      resourceType: 'channel_binding',
      resourceId: result[0].id,
      details: { channelType, externalId, admin: !!opts?.admin },
    });
    return true;
  }

  /** Reap expired and redeemed codes older than 24h. */
  async reapStaleCodes(): Promise<number> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await this.db
      .delete(channelLinkCodes)
      .where(sql`${channelLinkCodes.expiresAt} < ${cutoff} OR (${channelLinkCodes.redeemedAt} IS NOT NULL AND ${channelLinkCodes.redeemedAt} < ${cutoff})`)
      .returning({ id: channelLinkCodes.id });
    return result.length;
  }
}

let instance: ChannelBindingManager | null = null;

export function getChannelBindingManager(): ChannelBindingManager {
  if (!instance) instance = new ChannelBindingManager();
  return instance;
}

export function _resetChannelBindingManagerForTests(): void {
  instance = null;
}

// Re-exports so callers don't need to know which file the row types live in.
export type { ChannelIdentity, ChannelLinkCode };
