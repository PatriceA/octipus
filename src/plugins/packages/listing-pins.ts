/**
 * Listing pins (docs/PLUGIN-PACKAGES.md#listing-pins): the content hash of
 * each `name@version` as a registry first listed it, kept in the database
 * with the key that signed the index it came from.
 *
 * A published version never changes content. A later index that claims
 * another hash for a version already seen is an attempt to replace it in
 * silence: that entry is refused ("replaced: refused") and the admins are
 * told, and the rest of the index stays usable.
 *
 * A pin is only as good as its signer: one whose signing key is revoked since
 * holds nothing back (it is dropped, and the version pinned afresh), so a
 * leaked key cannot squat a future version by listing it first. An admin can
 * reset a pin (`resetPin`, audited, with a reason).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { auditRepository } from '@/db/repositories/audit-repository';
import { pluginListingPins } from '@/db/schema/plugin-packages';
import type { IndexEntry } from './index-v2';

/** A listed version whose content hash differs from the one pinned for it. */
export interface PinMismatch {
  name: string;
  version: string;
  pinned: string;
  listed: string;
  /** The key the pin was taken under, or null (an unsigned registry). */
  pinnedBy: string | null;
}

/**
 * Check an index's entries against the registry's pins. Pins taken under a
 * key in `revokedSigners` are dropped first (returned as `dropped`); the
 * entries whose hash differs from a pin that holds are returned as `changed`.
 */
export async function checkPins(
  registryUrl: string, entries: readonly IndexEntry[], revokedSigners: ReadonlySet<string>,
): Promise<{ changed: PinMismatch[]; dropped: Array<{ name: string; version: string; contentHash: string; signedBy: string }> }> {
  const hashed = entries.filter((e) => e.contentHash !== null);
  if (hashed.length === 0) return { changed: [], dropped: [] };
  const names = [...new Set(hashed.map((e) => e.name))];
  const pins = await getDb().select().from(pluginListingPins)
    .where(and(eq(pluginListingPins.registryUrl, registryUrl), inArray(pluginListingPins.name, names)));
  const dropped = pins.filter((p) => p.signedBy !== null && revokedSigners.has(p.signedBy))
    .map((p) => ({ name: p.name, version: p.version, contentHash: p.contentHash, signedBy: p.signedBy as string }));
  for (const signer of new Set(dropped.map((d) => d.signedBy))) {
    await getDb().delete(pluginListingPins).where(and(
      eq(pluginListingPins.registryUrl, registryUrl), eq(pluginListingPins.signedBy, signer),
      inArray(pluginListingPins.name, [...new Set(dropped.filter((d) => d.signedBy === signer).map((d) => d.name))]),
    ));
  }
  const gone = new Set(dropped.map((d) => `${d.name}@${d.version}`));
  const pinned = new Map(pins.filter((p) => !gone.has(`${p.name}@${p.version}`)).map((p) => [`${p.name}@${p.version}`, p]));
  const changed = hashed
    .filter((e) => pinned.has(`${e.name}@${e.version}`) && pinned.get(`${e.name}@${e.version}`)?.contentHash !== e.contentHash)
    .map((e) => {
      const pin = pinned.get(`${e.name}@${e.version}`);
      return { name: e.name, version: e.version, pinned: pin?.contentHash as string, listed: e.contentHash as string, pinnedBy: pin?.signedBy ?? null };
    });
  return { changed, dropped };
}

/** Pin the content hashes of versions seen for the first time, under the key that signed the index (those already pinned stay as they are). */
export async function pinListings(registryUrl: string, entries: readonly IndexEntry[], signedBy: string | null = null): Promise<void> {
  const rows = entries.filter((e) => e.contentHash !== null).map((e) => ({ registryUrl, name: e.name, version: e.version, contentHash: e.contentHash as string, signedBy }));
  for (let i = 0; i < rows.length; i += 500) {
    await getDb().insert(pluginListingPins).values(rows.slice(i, i + 500)).onConflictDoNothing();
  }
}

/**
 * Reset one pin (an admin's decision, audited with their reason): the next
 * index read pins that version afresh. Returns the pin removed, or null.
 */
export async function resetPin(registryUrl: string, name: string, version: string, actorUserId: string, reason: string): Promise<{ contentHash: string; signedBy: string | null } | null> {
  const [row] = await getDb().delete(pluginListingPins).where(and(
    eq(pluginListingPins.registryUrl, registryUrl), eq(pluginListingPins.name, name), eq(pluginListingPins.version, version),
  )).returning();
  if (!row) return null;
  await auditRepository.log({
    userId: actorUserId, action: 'settings_changed', resourceType: 'plugin_package', resourceId: name,
    details: { op: 'listing_pin_reset', registryUrl, name, version, contentHash: row.contentHash, signedBy: row.signedBy, reason: reason.slice(0, 500) },
  });
  return { contentHash: row.contentHash, signedBy: row.signedBy };
}
