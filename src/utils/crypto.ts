import { argon2 as cryptoArgon2, createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;

export interface EncryptedData {
  ciphertext: string;
  iv: string;
  authTag: string;
  salt?: string;
}

/**
 * Derive a key from a password using scrypt (Node.js built-in, no native addons)
 */
export async function deriveKey(password: string, salt?: Buffer): Promise<{ key: Buffer; salt: Buffer }> {
  const actualSalt = salt || randomBytes(SALT_LENGTH);

  const key = scryptSync(password, actualSalt, 32, {
    N: 16384,  // CPU/memory cost (2^14)
    r: 8,      // block size
    p: 1,      // parallelization
  });

  return { key: Buffer.from(key), salt: actualSalt };
}

/**
 * Encrypt data using AES-256-GCM
 */
export function encrypt(data: string, key: Buffer): EncryptedData {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let ciphertext = cipher.update(data, 'utf8', 'base64');
  ciphertext += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  return {
    ciphertext,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * Decrypt data using AES-256-GCM
 */
export function decrypt(encrypted: EncryptedData, key: Buffer): string {
  const iv = Buffer.from(encrypted.iv, 'base64');
  const authTag = Buffer.from(encrypted.authTag, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted.ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Encrypt data with password (includes key derivation)
 */
export async function encryptWithPassword(data: string, password: string): Promise<EncryptedData> {
  const { key, salt } = await deriveKey(password);
  const encrypted = encrypt(data, key);
  encrypted.salt = salt.toString('base64');
  return encrypted;
}

/**
 * Decrypt data with password
 */
export async function decryptWithPassword(encrypted: EncryptedData, password: string): Promise<string> {
  if (!encrypted.salt) {
    throw new Error('Salt is required for password-based decryption');
  }

  const salt = Buffer.from(encrypted.salt, 'base64');
  const { key } = await deriveKey(password, salt);
  return decrypt(encrypted, key);
}

/**
 * Generate a secure random token
 */
export function generateToken(length: number = 32): string {
  return randomBytes(length).toString('hex');
}

/**
 * Generate a secure random ID
 */
export function generateId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Hash data using SHA-256
 */
export function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Argon2id, in the PHC string format.
 *
 * The parameters and the encoding are pinned to what the previous runtime
 * produced, so every password hash already in the database still verifies:
 * `$argon2id$v=19$m=65536,t=3,p=1$<salt>$<tag>`, unpadded base64, 16-byte salt,
 * 32-byte tag. `crypto.argon2` reproduces those digests byte for byte — the
 * test beside this file pins one such hash and would fail if any of it drifted.
 */
const ARGON2_MEMORY = 65536; // 64 MB
const ARGON2_PASSES = 3;
const ARGON2_PARALLELISM = 1;
const ARGON2_TAG_BYTES = 32;
const ARGON2_SALT_BYTES = 16;

function b64(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '');
}

async function argon2id(
  password: string,
  salt: Buffer,
  options: { memory: number; passes: number; parallelism: number; tagLength: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    cryptoArgon2(
      'argon2id',
      {
        message: Buffer.from(password, 'utf8'),
        nonce: salt,
        parallelism: options.parallelism,
        tagLength: options.tagLength,
        memory: options.memory,
        passes: options.passes,
      },
      (err, tag) => (err ? reject(err) : resolve(Buffer.from(tag))),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(ARGON2_SALT_BYTES);
  const tag = await argon2id(password, salt, {
    memory: ARGON2_MEMORY,
    passes: ARGON2_PASSES,
    parallelism: ARGON2_PARALLELISM,
    tagLength: ARGON2_TAG_BYTES,
  });
  return `$argon2id$v=19$m=${ARGON2_MEMORY},t=${ARGON2_PASSES},p=${ARGON2_PARALLELISM}$${b64(salt)}$${b64(tag)}`;
}

/**
 * Verify against a stored PHC string, reading the cost parameters out of the
 * hash rather than assuming today's constants — otherwise raising a cost would
 * lock out every existing user.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const parts = hash.split('$');
  // ['', 'argon2id', 'v=19', 'm=..,t=..,p=..', salt, tag]
  if (parts.length !== 6 || parts[1] !== 'argon2id') return false;
  const params = Object.fromEntries(
    parts[3].split(',').map((kv) => {
      const [k, v] = kv.split('=');
      return [k, Number(v)];
    }),
  ) as { m?: number; t?: number; p?: number };
  if (!params.m || !params.t || !params.p) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = await argon2id(password, salt, {
    memory: params.m,
    passes: params.t,
    parallelism: params.p,
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Generate TOTP secret
 */
export function generateTotpSecret(): string {
  return randomBytes(20).toString('base64');
}

/**
 * Derive a 256-bit data-encryption key (DEK) via HKDF-SHA256.
 *
 * Used by the vault's per-user / per-scope key derivation (Phase 1b-2):
 * the master key is the IKM, the principal's userId is the salt, and a
 * versioned `info` string tags the use case so DEKs across different
 * subsystems never collide.
 *
 * Deterministic — same `(masterKey, scope, userId)` triple always
 * yields the same key, so existing ciphertexts remain decryptable
 * across restarts without storing the DEK anywhere.
 */
export function deriveDek(
  masterKey: Buffer,
  scope: string,
  userId: string,
): Buffer {
  const info = `octipus-vault-dek-v2:${scope}:${userId}`;
  // Salt: per-user identifier (stable across the user's lifetime).
  // Use a fixed salt prefix + userId so even brute-force key recovery
  // requires the master key.
  const salt = Buffer.from(`octipus-dek-salt-v2:${userId}`);
  const buf = hkdfSync('sha256', masterKey, salt, info, 32);
  return Buffer.from(buf);
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
export function secureCompare(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  const bufA = Buffer.alloc(maxLen, 0);
  const bufB = Buffer.alloc(maxLen, 0);
  bufA.write(a);
  bufB.write(b);
  return a.length === b.length && timingSafeEqual(bufA, bufB);
}
