import { describe, test, expect } from 'bun:test';
import {
  deriveKey,
  encrypt,
  decrypt,
  encryptWithPassword,
  decryptWithPassword,
  generateToken,
  generateId,
  generateTotpSecret,
  sha256,
  hashPassword,
  verifyPassword,
  secureCompare,
} from './crypto';

describe('Crypto Utils', () => {
  describe('deriveKey', () => {
    test('derives key from password', async () => {
      const { key, salt } = await deriveKey('password123');

      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
      expect(salt).toBeInstanceOf(Buffer);
    });

    test('derives same key with same salt', async () => {
      const { key: key1, salt } = await deriveKey('password123');
      const { key: key2 } = await deriveKey('password123', salt);

      expect(key1.equals(key2)).toBe(true);
    });

    test('derives different keys with different passwords', async () => {
      const { key: key1, salt } = await deriveKey('password1');
      const { key: key2 } = await deriveKey('password2', salt);

      expect(key1.equals(key2)).toBe(false);
    });
  });

  describe('encrypt/decrypt', () => {
    test('encrypts and decrypts string data', async () => {
      const { key } = await deriveKey('testpassword');
      const plaintext = 'Hello, World!';

      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);

      expect(decrypted).toBe(plaintext);
    });

    test('encrypted data has required fields', async () => {
      const { key } = await deriveKey('testpassword');
      const encrypted = encrypt('test', key);

      expect(encrypted).toHaveProperty('ciphertext');
      expect(encrypted).toHaveProperty('iv');
      expect(encrypted).toHaveProperty('authTag');
    });

    test('produces different ciphertext for same plaintext', async () => {
      const { key } = await deriveKey('testpassword');
      const plaintext = 'Same message';

      const encrypted1 = encrypt(plaintext, key);
      const encrypted2 = encrypt(plaintext, key);

      expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
    });
  });

  describe('generateToken', () => {
    test('generates token of default length', () => {
      const token = generateToken();

      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });

    test('generates token of specified length', () => {
      const token = generateToken(16);

      expect(token.length).toBe(32); // hex encoding doubles length
    });

    test('generates unique tokens', () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 100; i++) {
        tokens.add(generateToken());
      }
      expect(tokens.size).toBe(100);
    });
  });

  describe('generateId', () => {
    test('generates UUID-like ID', () => {
      const id = generateId();

      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    test('generates unique IDs', () => {
      const id1 = generateId();
      const id2 = generateId();

      expect(id1).not.toBe(id2);
    });
  });

  describe('sha256', () => {
    test('hashes string to hex', () => {
      const hash = sha256('hello');

      expect(typeof hash).toBe('string');
      expect(hash.length).toBe(64); // SHA-256 produces 32 bytes = 64 hex chars
    });

    test('produces consistent hash', () => {
      const hash1 = sha256('same input');
      const hash2 = sha256('same input');

      expect(hash1).toBe(hash2);
    });

    test('different inputs produce different hashes', () => {
      const hash1 = sha256('input1');
      const hash2 = sha256('input2');

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('hashPassword/verifyPassword', () => {
    test('hashes password', async () => {
      const hash = await hashPassword('MyPassword123');

      expect(typeof hash).toBe('string');
      expect(hash).not.toBe('MyPassword123');
    });

    test('verifies correct password', async () => {
      const password = 'MyPassword123';
      const hash = await hashPassword(password);

      const isValid = await verifyPassword(password, hash);

      expect(isValid).toBe(true);
    });

    test('rejects incorrect password', async () => {
      const hash = await hashPassword('correct');

      const isValid = await verifyPassword('incorrect', hash);

      expect(isValid).toBe(false);
    });
  });

  describe('secureCompare', () => {
    test('returns true for equal strings', () => {
      expect(secureCompare('abc', 'abc')).toBe(true);
    });

    test('returns false for different strings', () => {
      expect(secureCompare('abc', 'def')).toBe(false);
    });

    test('returns false for different length strings', () => {
      expect(secureCompare('abc', 'abcd')).toBe(false);
    });

    test('returns true for empty equal strings', () => {
      expect(secureCompare('', '')).toBe(true);
    });
  });

  describe('encryptWithPassword/decryptWithPassword', () => {
    test('round-trips data with password', async () => {
      const enc = await encryptWithPassword('top secret', 'pw1');
      expect(enc.salt).toBeTruthy();
      const dec = await decryptWithPassword(enc, 'pw1');
      expect(dec).toBe('top secret');
    });

    test('decrypt with wrong password throws', async () => {
      const enc = await encryptWithPassword('payload', 'right');
      await expect(decryptWithPassword(enc, 'wrong')).rejects.toThrow();
    });

    test('decryptWithPassword without salt throws', async () => {
      const { key } = await deriveKey('pw');
      const enc = encrypt('hi', key); // no salt set
      await expect(decryptWithPassword(enc, 'pw')).rejects.toThrow(/Salt is required/);
    });
  });

  describe('generateTotpSecret', () => {
    test('returns base64 string', () => {
      const s = generateTotpSecret();
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(0);
      // base64 of 20 random bytes → 28 chars (with padding)
      expect(s).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    test('generates unique secrets', () => {
      expect(generateTotpSecret()).not.toBe(generateTotpSecret());
    });
  });
});
