import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual, scryptSync } from 'crypto';

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

  const decipher = createDecipheriv(ALGORITHM, key, iv);
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
 * Hash password using Argon2id (Bun built-in, no native addons)
 */
export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, {
    algorithm: 'argon2id',
    memoryCost: 65536, // 64 MB
    timeCost: 3,
  });
}

/**
 * Verify password against hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

/**
 * Generate TOTP secret
 */
export function generateTotpSecret(): string {
  return randomBytes(20).toString('base64');
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
