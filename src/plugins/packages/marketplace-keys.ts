/**
 * The built-in Octipus marketplace (docs/PLUGIN-PACKAGES.md#marketplace-keys):
 * where its signed index is, the publisher name its packages are signed
 * under, and its two ROOT public keys.
 *
 * Root keys never sign packages or indexes. They sign one small file,
 * `keys.json` on the marketplace's origin, which lists the SIGNING keys
 * (and revokes old ones). Signing keys can therefore be rotated, and a
 * leaked one revoked, without a new Octipus release
 * (./marketplace-keys-file.ts).
 *
 * Official builds ship the two public trust anchors below. New installations
 * can verify the official marketplace without generating or configuring keys.
 * Only PUBLIC keys belong here. Private roots stay with the publisher and
 * sign keys.json; they are never needed by an Octipus installation.
 *
 * A host can point at another marketplace, or other root keys, for testing
 * or self-hosting: `plugins.marketplace: { url, rootKeys: { root, rootBackup } }`.
 */

/** The marketplace's signed index (its signature is `<url>.sig`; its keys file `<origin>/keys.json`). */
export const MARKETPLACE_URL = 'https://plugins.octipus.cc/index.json';

/** The publisher its packages and index are signed as (what `signedBy` shows). */
export const MARKETPLACE_PUBLISHER = 'Octipus';

/** A root public key, or a placeholder that stands for none. */
export type MarketplaceKeySlot =
  | { placeholder: true; publicKey: null; note: string }
  | { placeholder: false; publicKey: string };

/**
 * The two root keys. Either may sign `keys.json`. `rootBackup` may revoke
 * `root` (a lost or leaked root); `root` may never revoke `rootBackup`.
 */
export const MARKETPLACE_ROOT_KEYS: { readonly root: MarketplaceKeySlot; readonly rootBackup: MarketplaceKeySlot } = Object.freeze({
  root: Object.freeze({ placeholder: false, publicKey: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAMxrCbKOaW2S7N2vmOMQbk607b5hX1rFWVbwkTq+ua/8=
-----END PUBLIC KEY-----
` } as const),
  rootBackup: Object.freeze({ placeholder: false, publicKey: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAdVsJCRh8prqQwi4B2eZj1x9YvTr53TUqFD1Yrk1iZiY=
-----END PUBLIC KEY-----
` } as const),
});
