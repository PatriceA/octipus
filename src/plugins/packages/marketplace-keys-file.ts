/**
 * The marketplace's signing keys (docs/PLUGIN-PACKAGES.md#marketplace-keys).
 *
 * The built-in ROOT keys (./marketplace-keys.ts) sign one file on the
 * marketplace's origin, `keys.json`, beside its detached `keys.json.sig`
 * (the canonical signature form, over `octipus-marketplace-keys/v1\n` and
 * the sha256 of the exact bytes: never interchangeable with a package or
 * index signature):
 *
 *   { "schema": 1, "version": 3, "generatedAt": "…",
 *     "signingKeys": [{ "keyId": "ed25519:…", "publicKey": "-----BEGIN PUBLIC KEY-----…", "notAfter": "2027-12-31" }],
 *     "revokedKeys": [{ "keyId": "ed25519:…", "reason": "…" }] }
 *
 * The host:
 *
 * - fetches it through the SSRF guard from the marketplace origin (64 KiB at
 *   most, no redirect off the origin) and verifies it against the root keys
 *   that are not revoked;
 * - refuses a `version` not greater than the last accepted one (the same
 *   version with the same bytes is fine), unless the last one was signed by a
 *   root revoked since;
 * - applies the root rule: `rootBackup` may revoke `root`, `root` may never
 *   revoke `rootBackup` (a file that tries is refused as a whole), a key may
 *   retire itself; a root is never a signing key;
 * - stores revocations sticky (./revocations.ts): a later version that drops
 *   one does not lift it;
 * - persists the last good file with its signature, re-verified whenever it
 *   is read, so installed marketplace packages keep verifying while the
 *   marketplace is unreachable.
 *
 * Only listed, non-revoked, unexpired signing keys are trusted, for the
 * marketplace's index and for its packages. Without a valid keys.json the
 * marketplace is unavailable.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { auditRepository } from '@/db/repositories/audit-repository';
import { pluginMarketplaceKeys } from '@/db/schema/plugin-packages';
import { SYSTEM_USER_ID } from '@/security/principal';
import { coreLogger } from '@/utils/logger';
import { isoTime, line } from './index-v2';
import { currentMarketplace, type MarketplaceSettings, type RootKey } from './marketplace-config';
import { MARKETPLACE_PUBLISHER } from './marketplace-keys';
import { applyNewRevocations } from './revocation-effects';
import { recordRevocations, revokedKeyIds } from './revocations';
import { isKeyId, keyFingerprint, parsePublicKey, type TrustedPublisher, verifyMarketplaceKeys } from './signature';

/** Largest keys.json read. */
export const MAX_KEYS_FILE_BYTES = 64 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const KEYS_TIMEOUT_MS = 10_000;
/** How long a fetched keys.json is reused. */
export const KEYS_CACHE_MS = 60_000;

export class KeysFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeysFileError';
  }
}

const keyIdSchema = z.string().max(80).refine(isKeyId, 'a key id, ed25519:<64 hex>');
const dateOrTime = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/, 'an ISO date or date-time with a zone')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'not a real date');

const keysFileSchema = z.object({
  schema: z.literal(1),
  version: z.number().int().min(1).max(2_147_483_647),
  generatedAt: isoTime,
  signingKeys: z.array(z.object({ keyId: keyIdSchema, publicKey: z.string().min(1).max(2000), notAfter: dateOrTime.optional().nullable() }).strict()).max(20),
  revokedKeys: z.array(z.object({ keyId: keyIdSchema, reason: line(500).optional().nullable() }).strict()).max(1000),
}).strict();

export interface KeysFile {
  version: number;
  generatedAt: Date;
  signingKeys: Array<{ keyId: string; publicKey: string; notAfter: string | null }>;
  revokedKeys: Array<{ keyId: string; reason: string }>;
}

/** Parse and check a keys file's content (its signature is checked separately). */
export function parseKeysFile(bytes: Uint8Array, roots: readonly RootKey[]): KeysFile {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new KeysFileError('keys.json is not valid JSON');
  }
  const parsed = keysFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new KeysFileError(`keys.json does not fit its schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')}`);
  }
  const rootIds = new Set(roots.map((r) => r.keyId));
  const seen = new Set<string>();
  for (const k of parsed.data.signingKeys) {
    let id: string;
    try {
      id = keyFingerprint(parsePublicKey(k.publicKey));
    } catch (err) {
      throw new KeysFileError(`keys.json: the signing key ${k.keyId} cannot be read (${(err as Error).message})`);
    }
    if (id !== k.keyId) throw new KeysFileError(`keys.json: the signing key listed as ${k.keyId} is ${id}`);
    if (rootIds.has(id)) throw new KeysFileError(`keys.json lists a root key (${id}) as a signing key; root keys never sign packages or indexes`);
    if (seen.has(id)) throw new KeysFileError(`keys.json lists the signing key ${id} twice`);
    seen.add(id);
  }
  return {
    version: parsed.data.version,
    generatedAt: new Date(parsed.data.generatedAt),
    signingKeys: parsed.data.signingKeys.map((k) => ({ keyId: k.keyId, publicKey: k.publicKey, notAfter: k.notAfter ?? null })),
    revokedKeys: parsed.data.revokedKeys.map((k) => ({ keyId: k.keyId, reason: k.reason ?? '' })),
  };
}

/**
 * Whether a keys file signed by root `signer` may revoke these keys: a key
 * may retire itself, and any signing key may be revoked; of the roots, only
 * `rootBackup` may revoke `root`. Returns why not, or null.
 */
export function rootRevocationProblem(signer: string, roots: readonly RootKey[], revoked: readonly string[]): string | null {
  const roleOf = new Map(roots.map((r) => [r.keyId, r.role]));
  const signerRole = roleOf.get(signer);
  if (signerRole === undefined) return `keys.json is signed by ${signer}, which is not a root key`;
  for (const target of revoked) {
    if (target === signer) continue;
    const targetRole = roleOf.get(target);
    if (targetRole === undefined) continue;
    if (signerRole === 'rootBackup' && targetRole === 'root') continue;
    return `keys.json signed by the ${signerRole} key may not revoke the ${targetRole} key (${target}); the whole file is refused`;
  }
  return null;
}

/** Key ids revoked now: `plugins.revokedKeys` and the stored revocations. */
async function revokedNow(): Promise<string[]> {
  return [...new Set([...(getConfig().plugins?.revokedKeys ?? []), ...await revokedKeyIds()])];
}

/** The root keys as publisher entries, for a key ring. */
function rootPublishers(roots: readonly RootKey[]): TrustedPublisher[] {
  return roots.map((r) => ({ name: `${MARKETPLACE_PUBLISHER} (${r.role})`, publicKey: r.publicKey }));
}

/** Check a keys file's bytes and signature against the roots (revoked roots excluded). Returns the file and the root that signed it. */
export async function verifyKeysFile(settings: Extract<MarketplaceSettings, { state: 'ready' }>, bytes: Uint8Array, signatureText: string | null): Promise<{ file: KeysFile; signedBy: string }> {
  const check = verifyMarketplaceKeys(bytes, signatureText, rootPublishers(settings.roots), { revokedKeys: await revokedNow() });
  if (check.status !== 'valid') {
    const why = check.status === 'unsigned' ? 'keys.json is not signed (keys.json.sig missing)'
      : check.status === 'invalid' ? `the keys.json signature is not valid: ${check.reason}`
        : check.status === 'unknown_key' ? `keys.json is signed by ${check.keyId}, which is not a root key of this build`
          : `the keys.json signature does not count: ${check.detail}`;
    throw new KeysFileError(why);
  }
  return { file: parseKeysFile(bytes, settings.roots), signedBy: check.keyId };
}

/** The trusted signing keys of a keys file: listed, not revoked (now, or by the file), as publisher entries carrying their `notAfter`. */
export function signingPublishers(file: KeysFile, revoked: readonly string[]): TrustedPublisher[] {
  const out = new Set([...revoked, ...file.revokedKeys.map((k) => k.keyId)]);
  return file.signingKeys
    .filter((k) => !out.has(k.keyId))
    .map((k) => ({ name: MARKETPLACE_PUBLISHER, publicKey: k.publicKey, ...(k.notAfter ? { notAfter: k.notAfter } : {}) }));
}

/**
 * Accept a verified keys file as the newest (one conditional upsert), or
 * throw saying why not: `version` must grow, unless the last one was signed
 * by a root revoked now.
 */
async function acceptVersion(settings: Extract<MarketplaceSettings, { state: 'ready' }>, file: KeysFile, bytes: Uint8Array, signature: string, signedBy: string, distrusted: readonly string[]): Promise<void> {
  const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const body = Buffer.from(bytes).toString('utf8');
  const t = pluginMarketplaceKeys;
  const distrust = distrusted.length > 0 ? sql` OR ${t.signedByRoot} IN (${sql.join(distrusted.map((k) => sql`${k}`), sql`, `)})` : sql``;
  const accepted = await getDb().insert(t)
    .values({ registryUrl: settings.url, version: file.version, generatedAt: file.generatedAt, body, signature, sha256, signedByRoot: signedBy })
    .onConflictDoUpdate({
      target: t.registryUrl,
      set: { version: file.version, generatedAt: file.generatedAt, body, signature, sha256, signedByRoot: signedBy, acceptedAt: new Date() },
      setWhere: sql`${t.version} < ${file.version} OR (${t.version} = ${file.version} AND ${t.sha256} = ${sha256})${distrust}`,
    })
    .returning({ version: t.version });
  if (accepted.length > 0) return;
  const [last] = await getDb().select({ version: t.version }).from(t).where(sql`${t.registryUrl} = ${settings.url}`).limit(1);
  throw new KeysFileError(last && last.version === file.version
    ? `keys.json version ${file.version} has other content than the version ${file.version} accepted before; refused`
    : `keys.json version ${file.version} is not newer than the last one accepted (${last?.version ?? '?'}); an older keys file is never accepted again`);
}

/** The keys file accepted now, with its trusted signing keys. */
export interface MarketplaceSigningKeys {
  version: number;
  signedBy: string;
  publishers: TrustedPublisher[];
}

type Cached = { at: number; key: string; result: MarketplaceSigningKeys | { error: string } };
let cache: Cached | null = null;

/** Forget the cached keys file (tests, a config change). */
export function clearKeysCache(): void {
  cache = null;
  persistedCache = null;
}

/**
 * Fetch, verify and accept the marketplace's keys.json (cached a minute):
 * its trusted signing keys, or `{ error }` (the marketplace is unavailable).
 * New revocations it carries are stored and applied.
 */
export async function marketplaceSigningKeys(settings: MarketplaceSettings = currentMarketplace()): Promise<MarketplaceSigningKeys | { error: string }> {
  if (settings.state !== 'ready') return { error: 'The Octipus marketplace is not configured' };
  const key = JSON.stringify([settings.url, settings.roots.map((r) => r.keyId), getConfig().plugins?.revokedKeys ?? []]);
  if (cache && cache.key === key && Date.now() - cache.at < KEYS_CACHE_MS) return cache.result;
  let result: MarketplaceSigningKeys | { error: string };
  try {
    result = await fetchAndAccept(settings);
  } catch (err) {
    const { isIndexRefusal } = await import('./remote');
    if (!(err instanceof KeysFileError) && !isIndexRefusal(err)) throw err;
    coreLogger.warn({ err: (err as Error).message }, 'plugin marketplace: keys.json refused or unreachable; the marketplace is unavailable');
    result = { error: `The marketplace keys could not be verified: ${(err as Error).message}` };
  }
  cache = { at: Date.now(), key, result };
  return result;
}

async function fetchAndAccept(settings: Extract<MarketplaceSettings, { state: 'ready' }>): Promise<MarketplaceSigningKeys> {
  const { downloadHttps, RemoteFetchError } = await import('./remote');
  const bytes = await downloadHttps(settings.keysUrl, { maxBytes: MAX_KEYS_FILE_BYTES, timeoutMs: KEYS_TIMEOUT_MS, accept: 'application/json', sameOrigin: true });
  let signature: string | null;
  try {
    signature = (await downloadHttps(`${settings.keysUrl}.sig`, { maxBytes: MAX_SIGNATURE_BYTES, timeoutMs: KEYS_TIMEOUT_MS, sameOrigin: true })).toString('utf8');
  } catch (err) {
    if (!(err instanceof RemoteFetchError) || !/answered HTTP 404\b/.test(err.message)) throw err;
    signature = null;
  }
  const { file, signedBy } = await verifyKeysFile(settings, bytes, signature);
  const problem = rootRevocationProblem(signedBy, settings.roots, file.revokedKeys.map((k) => k.keyId));
  if (problem) {
    await auditRepository.log({
      userId: SYSTEM_USER_ID, action: 'permission_denied', resourceType: 'plugin_package', resourceId: 'marketplace',
      details: { op: 'marketplace_keys_refused', signer: signedBy, problem, version: file.version },
    }).catch((err: unknown) => coreLogger.error({ err }, 'plugin marketplace: audit row could not be written'));
    throw new KeysFileError(problem);
  }
  await acceptVersion(settings, file, bytes, signature as string, signedBy, [...await revokedNow(), ...file.revokedKeys.map((k) => k.keyId)]);
  const added = await recordRevocations(file.revokedKeys.map((k) => ({ kind: 'key' as const, keyId: k.keyId, reason: k.reason })),
    { registryUrl: settings.keysUrl, signedByKey: signedBy, indexGeneratedAt: file.generatedAt });
  if (added.length > 0) {
    cache = null;
    await applyNewRevocations(added);
  }
  return { version: file.version, signedBy, publishers: signingPublishers(file, await revokedNow()) };
}

let persistedCache: { key: string; publishers: TrustedPublisher[] } | null = null;

/**
 * The signing keys of the last accepted keys.json in the database,
 * re-verified against the root keys now (a root revoked since makes it
 * count for nothing), minus the keys revoked now. What installed marketplace
 * packages are checked against, with or without the network. Empty when the
 * marketplace is not configured or nothing was accepted yet.
 */
export async function persistedSigningPublishers(settings: MarketplaceSettings = currentMarketplace()): Promise<TrustedPublisher[]> {
  if (settings.state !== 'ready') return [];
  const [row] = await getDb().select().from(pluginMarketplaceKeys).where(sql`${pluginMarketplaceKeys.registryUrl} = ${settings.url}`).limit(1);
  if (!row) return [];
  const revoked = await revokedNow();
  const cacheKey = JSON.stringify([row.sha256, revoked, settings.roots.map((r) => r.keyId)]);
  if (persistedCache && persistedCache.key === cacheKey) return persistedCache.publishers;
  try {
    const { file } = await verifyKeysFile(settings, Buffer.from(row.body, 'utf8'), row.signature);
    const publishers = signingPublishers(file, revoked);
    persistedCache = { key: cacheKey, publishers };
    return publishers;
  } catch (err) {
    if (!(err instanceof KeysFileError)) throw err;
    coreLogger.warn({ err: err.message }, 'plugin marketplace: the stored keys.json no longer verifies; its keys trust nothing');
    return [];
  }
}
