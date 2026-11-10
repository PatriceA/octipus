/**
 * Listing pins (docs/PLUGIN-PACKAGES.md#marketplace-keys): the content hash
 * of each `name@version` as a registry first listed it, kept in the database.
 * A published version never changes content; a later index that claims
 * another hash for a version already seen is an attempt to replace it in
 * silence, and is refused as a whole (and the admins are told).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { pluginListingPins } from '@/db/schema/plugin-packages';
import type { IndexEntry } from './index-v2';

export class ListingPinError extends Error {
  constructor(message: string, readonly changed: Array<{ name: string; version: string; pinned: string; listed: string }>) {
    super(message);
    this.name = 'ListingPinError';
  }
}

/** Entries whose content hash differs from the one pinned for their name and version in this registry. */
export async function pinMismatches(registryUrl: string, entries: readonly IndexEntry[]): Promise<ListingPinError['changed']> {
  const hashed = entries.filter((e) => e.contentHash !== null);
  if (hashed.length === 0) return [];
  const names = [...new Set(hashed.map((e) => e.name))];
  const pins = await getDb().select().from(pluginListingPins)
    .where(and(eq(pluginListingPins.registryUrl, registryUrl), inArray(pluginListingPins.name, names)));
  const pinned = new Map(pins.map((p) => [`${p.name}@${p.version}`, p.contentHash]));
  return hashed
    .filter((e) => pinned.has(`${e.name}@${e.version}`) && pinned.get(`${e.name}@${e.version}`) !== e.contentHash)
    .map((e) => ({ name: e.name, version: e.version, pinned: pinned.get(`${e.name}@${e.version}`) as string, listed: e.contentHash as string }));
}

/** Pin the content hashes of versions seen for the first time (those already pinned stay as they are). */
export async function pinListings(registryUrl: string, entries: readonly IndexEntry[]): Promise<void> {
  const rows = entries.filter((e) => e.contentHash !== null).map((e) => ({ registryUrl, name: e.name, version: e.version, contentHash: e.contentHash as string }));
  for (let i = 0; i < rows.length; i += 500) {
    await getDb().insert(pluginListingPins).values(rows.slice(i, i + 500)).onConflictDoNothing();
  }
}
