/**
 * The manifest's `store` field (docs/PLUGIN-PACKAGES.md#store): the per-user
 * store a package asks the host to keep for it. Kept apart from
 * ./manifest.ts, which spreads `STORE_FIELDS` into its schema and calls
 * `storeProblems`.
 *
 * `store: { quotaBytes? }` declares the store and its quota per user
 * (default 5 MB, at most 20 MB). It goes with the host scopes `store:read`
 * and/or `store:write`: a store without either is refused (nothing could
 * reach it), and so is either scope without a store (no quota was declared,
 * so none was consented to).
 */
import { z } from 'zod';
import {
  formatStoreBytes,
  PLUGIN_STORE_MAX_QUOTA_BYTES,
  PLUGIN_STORE_MIN_QUOTA_BYTES,
  PLUGIN_STORE_SCOPES,
} from '@/shared/plugin-package';

export const storeSchema = z.object({
  quotaBytes: z.number().int('store.quotaBytes: a whole number of bytes')
    .min(PLUGIN_STORE_MIN_QUOTA_BYTES, `store.quotaBytes: at least ${PLUGIN_STORE_MIN_QUOTA_BYTES} bytes`)
    .max(PLUGIN_STORE_MAX_QUOTA_BYTES, `store.quotaBytes: at most ${PLUGIN_STORE_MAX_QUOTA_BYTES} bytes (${formatStoreBytes(PLUGIN_STORE_MAX_QUOTA_BYTES)}) per user`)
    .optional(),
}).strict();

/** Spread into the manifest's object schema. */
export const STORE_FIELDS = {
  store: storeSchema.optional(),
};

/** The checks across fields, as messages (each one refuses the install). */
export function storeProblems(m: { store?: z.infer<typeof storeSchema>; host?: readonly string[] }): string[] {
  const scopes = (m.host ?? []).filter((s) => (PLUGIN_STORE_SCOPES as readonly string[]).includes(s));
  if (m.store && scopes.length === 0) {
    return ['store: declare the host scope store:read and/or store:write with it (nothing else reaches the store)'];
  }
  if (!m.store && scopes.length > 0) {
    return [`host: ${scopes.join(' and ')} need a "store" declaration (its quota per user, e.g. { "quotaBytes": 5242880 }, or {} for the default 5 MB)`];
  }
  return [];
}
