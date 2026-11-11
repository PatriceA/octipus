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
 * ┌─ PLACEHOLDERS ─────────────────────────────────────────────────────────┐
 * │ Both root keys below are placeholders: no key pair has been made for   │
 * │ this build. While either is a placeholder, the built-in marketplace is │
 * │ OFF: never fetched, never trusted, nothing installs from it, and the   │
 * │ admin listing says "The Octipus marketplace is not configured in this  │
 * │ build". A placeholder can never verify anything (marketplace.test.ts). │
 * │                                                                        │
 * │ To configure it, on an offline machine (never here, never in CI):      │
 * │   octi plugin keygen octipus-root --passphrase-file -                  │
 * │   octi plugin keygen octipus-root-backup --passphrase-file -           │
 * │ then paste the contents of `octipus-root.pub` into `root.publicKey`    │
 * │ and of `octipus-root-backup.pub` into `rootBackup.publicKey` (the      │
 * │ whole PEM, with its BEGIN/END lines), and set `placeholder: false` on  │
 * │ both. Only the PUBLIC halves ever go here. Keep both private keys      │
 * │ offline; they only sign keys.json (octi plugin sign-keys).             │
 * └────────────────────────────────────────────────────────────────────────┘
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
  root: Object.freeze({ placeholder: true, publicKey: null, note: 'PLACEHOLDER: paste the contents of octipus-root.pub (octi plugin keygen) here' } as const),
  rootBackup: Object.freeze({ placeholder: true, publicKey: null, note: 'PLACEHOLDER: paste the contents of octipus-root-backup.pub (octi plugin keygen) here' } as const),
});
