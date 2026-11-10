/**
 * The marketplace keys file's format (docs/PLUGIN-PACKAGES.md#marketplace-keys):
 * its schema, its parser, and the root revocation rule. Pure (no database, no
 * network, no config), so the offline CLI (`octi plugin sign-keys`,
 * `verify-keys`) checks a file exactly as a host reads it.
 *
 *   { "schema": 1, "version": 3, "generatedAt": "…", "expires": "…",
 *     "signingKeys": [{ "keyId": "ed25519:…", "publicKey": "-----BEGIN PUBLIC KEY-----…", "notAfter": "2027-12-31" }],
 *     "revokedKeys": [{ "keyId": "ed25519:…", "reason": "…" }] }
 *
 * `expires` is optional: after it, a host refuses the file (it cannot be
 * frozen on an old one forever).
 */
import { z } from 'zod';
import { isoTime, line, safeText } from './listing-text';
import { isKeyId, keyFingerprint, parsePublicKey } from './signature';

export class KeysFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeysFileError';
  }
}

/** A root key as the format needs it: its role and id. */
export interface RootKeyRef {
  role: 'root' | 'rootBackup';
  keyId: string;
}

const keyIdSchema = z.string().max(80).refine(isKeyId, 'a key id, ed25519:<64 hex>');
const dateOrTime = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/, 'an ISO date or date-time with a zone')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'not a real date');

export const keysFileSchema = z.object({
  schema: z.literal(1),
  version: z.number().int().min(1).max(2_147_483_647),
  generatedAt: isoTime,
  expires: isoTime.optional().nullable(),
  signingKeys: z.array(z.object({ keyId: keyIdSchema, publicKey: z.string().min(1).max(2000), notAfter: dateOrTime.optional().nullable() }).strict()).max(20),
  revokedKeys: z.array(z.object({ keyId: keyIdSchema, reason: line(500).optional().nullable() }).strict()).max(1000),
}).strict();

export interface KeysFile {
  version: number;
  generatedAt: Date;
  /** After this the file is refused; null: it does not expire. */
  expires: Date | null;
  signingKeys: Array<{ keyId: string; publicKey: string; notAfter: string | null }>;
  revokedKeys: Array<{ keyId: string; reason: string }>;
}

/** Parse and check a keys file's content (its signature is checked separately). Roots may never be signing keys. */
export function parseKeysFile(bytes: Uint8Array, roots: readonly Pick<RootKeyRef, 'keyId'>[]): KeysFile {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new KeysFileError('keys.json is not valid JSON');
  }
  const parsed = keysFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new KeysFileError(safeText(`keys.json does not fit its schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')}`));
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
    expires: parsed.data.expires ? new Date(parsed.data.expires) : null,
    signingKeys: parsed.data.signingKeys.map((k) => ({ keyId: k.keyId, publicKey: k.publicKey, notAfter: k.notAfter ?? null })),
    revokedKeys: parsed.data.revokedKeys.map((k) => ({ keyId: k.keyId, reason: k.reason ?? '' })),
  };
}

/** Why a keys file has expired at `now`, or null. */
export function keysFileExpired(file: Pick<KeysFile, 'expires' | 'version'>, now = new Date()): string | null {
  if (file.expires === null || file.expires.getTime() > now.getTime()) return null;
  return `keys.json version ${file.version} expired at ${file.expires.toISOString()}; refused (the marketplace must publish a fresh one)`;
}

/**
 * Whether a keys file signed by root `signer` may revoke these keys: a key
 * may retire itself, and any signing key may be revoked; of the roots, only
 * `rootBackup` may revoke `root`. Returns why not, or null.
 */
export function rootRevocationProblem(signer: string, roots: readonly RootKeyRef[], revoked: readonly string[]): string | null {
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
