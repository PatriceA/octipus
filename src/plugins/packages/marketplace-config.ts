/**
 * Whether the built-in marketplace is on, where it is and which ROOT keys
 * anchor it (docs/PLUGIN-PACKAGES.md#marketplace-keys). Kept apart from the
 * network side so the signature checks of installed packages
 * (./service.ts) can read it without importing a fetcher.
 *
 * Official builds ship public root keys (./marketplace-keys.ts). Custom builds
 * fail closed while either root is a placeholder, or a
 * key cannot be read, the marketplace is `unconfigured`: never fetched,
 * never trusted, nothing installs from it.
 */
import { getConfig } from '@/config';
import { coreLogger } from '@/utils/logger';
import { MARKETPLACE_ROOT_KEYS, MARKETPLACE_URL, type MarketplaceKeySlot } from './marketplace-keys';
import { keyFingerprint, parsePublicKey } from './signature';

/** The registry name marketplace entries and installs are filed under (`origin.source`). */
export const MARKETPLACE_REGISTRY = 'marketplace';

/** What the admin listing says while the build has no marketplace root keys. */
export const MARKETPLACE_UNCONFIGURED_MESSAGE = 'The Octipus marketplace is not configured in this build';
export const MARKETPLACE_OFF_MESSAGE = 'The Octipus marketplace is turned off (plugins.marketplace is false)';

export type RootRole = 'root' | 'rootBackup';

export interface RootKey {
  role: RootRole;
  publicKey: string;
  keyId: string;
}

export type MarketplaceSettings =
  | { state: 'off' }
  | { state: 'unconfigured'; url: string; reason: string }
  | { state: 'ready'; url: string; keysUrl: string; roots: RootKey[]; keySource: 'built-in' | 'config' };

type MarketplaceConfigValue = boolean | { enabled?: boolean; url?: string; rootKeys?: { root: string; rootBackup?: string } } | undefined;
type Slot = MarketplaceKeySlot | { placeholder: false; publicKey: string };

/** A key slot as a usable key, or why not. A placeholder never is. */
function readSlot(role: RootRole, slot: Slot): RootKey | string {
  if (slot.placeholder !== false || typeof slot.publicKey !== 'string' || slot.publicKey.trim() === '') return `the ${role} key is a placeholder`;
  try {
    return { role, publicKey: slot.publicKey, keyId: keyFingerprint(parsePublicKey(slot.publicKey)) };
  } catch (err) {
    return `the ${role} key cannot be read (${(err as Error).message})`;
  }
}

/** `<origin>/keys.json` of a marketplace index URL. */
export function keysFileUrl(indexUrl: string): string {
  return new URL('/keys.json', new URL(indexUrl).origin).toString();
}

/**
 * The marketplace as configured: `plugins.marketplace` (true, false, or an
 * override object) over the built-in URL and root keys. Root keys given in
 * the config count as configured; otherwise the built-in pair must both be real.
 */
export function marketplaceSettings(
  value: MarketplaceConfigValue = getConfig().plugins?.marketplace as MarketplaceConfigValue,
  builtIn: { readonly root: MarketplaceKeySlot; readonly rootBackup: MarketplaceKeySlot } = MARKETPLACE_ROOT_KEYS,
): MarketplaceSettings {
  if (value === false) return { state: 'off' };
  const override = typeof value === 'object' && value !== null ? value : null;
  if (override && override.enabled === false) return { state: 'off' };
  const url = override?.url ?? MARKETPLACE_URL;
  let slots: Array<[RootRole, Slot]>;
  let keySource: 'built-in' | 'config';
  if (override?.rootKeys) {
    keySource = 'config';
    slots = [['root', { placeholder: false, publicKey: override.rootKeys.root }]];
    if (override.rootKeys.rootBackup !== undefined) slots.push(['rootBackup', { placeholder: false, publicKey: override.rootKeys.rootBackup }]);
  } else {
    keySource = 'built-in';
    slots = [['root', builtIn.root], ['rootBackup', builtIn.rootBackup]];
  }
  const roots: RootKey[] = [];
  for (const [role, slot] of slots) {
    const read = readSlot(role, slot);
    if (typeof read === 'string') return { state: 'unconfigured', url, reason: read };
    roots.push(read);
  }
  if (new Set(roots.map((k) => k.keyId)).size !== roots.length) return { state: 'unconfigured', url, reason: 'the root and backup root keys are the same key' };
  let keysUrl: string;
  try {
    keysUrl = keysFileUrl(url);
  } catch {
    return { state: 'unconfigured', url, reason: 'the marketplace URL cannot be read' };
  }
  return { state: 'ready', url, keysUrl, roots, keySource };
}

let warned = '';
/** `marketplaceSettings()`, logging once why it is not ready when keys are present but unusable. */
export function currentMarketplace(): MarketplaceSettings {
  const settings = marketplaceSettings();
  if (settings.state === 'unconfigured' && !/placeholder/.test(settings.reason) && warned !== settings.reason) {
    warned = settings.reason;
    coreLogger.warn({ reason: settings.reason }, 'The plugin marketplace is not configured; it stays off');
  }
  return settings;
}
