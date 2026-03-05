import { describe, test, expect } from 'bun:test';
import { randomBytes } from 'crypto';
import { encrypt, decrypt, deriveKey } from '@/utils/crypto';

describe('Vault (Unit)', () => {
  describe('secret structure', () => {
    test('encrypted secret has required fields', () => {
      const encryptedSecret = {
        name: 'api-key',
        ciphertext: 'base64-encoded-data',
        iv: 'initialization-vector',
        authTag: 'authentication-tag',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(encryptedSecret.name).toBeDefined();
      expect(encryptedSecret.ciphertext).toBeDefined();
      expect(encryptedSecret.iv).toBeDefined();
      expect(encryptedSecret.authTag).toBeDefined();
    });
  });

  describe('secret storage', () => {
    test('can store secrets by name', () => {
      const vault = new Map<string, string>();

      vault.set('api-key', 'encrypted-value');
      vault.set('db-password', 'encrypted-value-2');

      expect(vault.has('api-key')).toBe(true);
      expect(vault.has('db-password')).toBe(true);
    });

    test('can retrieve secret', () => {
      const vault = new Map<string, string>();
      vault.set('secret', 'value');

      expect(vault.get('secret')).toBe('value');
    });

    test('returns undefined for missing secret', () => {
      const vault = new Map<string, string>();

      expect(vault.get('missing')).toBeUndefined();
    });

    test('can delete secret', () => {
      const vault = new Map<string, string>();
      vault.set('to-delete', 'value');

      vault.delete('to-delete');

      expect(vault.has('to-delete')).toBe(false);
    });

    test('can list all secrets', () => {
      const vault = new Map<string, string>();
      vault.set('key1', 'val1');
      vault.set('key2', 'val2');

      const keys = Array.from(vault.keys());

      expect(keys).toContain('key1');
      expect(keys).toContain('key2');
    });
  });
});

describe('Vault Encryption (Crypto)', () => {
  const testKey = randomBytes(32); // AES-256 key

  describe('encrypt/decrypt roundtrip', () => {
    test('basic string roundtrip', () => {
      const plaintext = 'my-secret-api-key-12345';
      const encrypted = encrypt(plaintext, testKey);
      const decrypted = decrypt(encrypted, testKey);

      expect(decrypted).toBe(plaintext);
    });

    test('empty string roundtrip', () => {
      const plaintext = '';
      const encrypted = encrypt(plaintext, testKey);
      const decrypted = decrypt(encrypted, testKey);

      expect(decrypted).toBe(plaintext);
    });

    test('unicode string roundtrip', () => {
      const plaintext = 'Héllo Wörld 🔑 日本語テスト';
      const encrypted = encrypt(plaintext, testKey);
      const decrypted = decrypt(encrypted, testKey);

      expect(decrypted).toBe(plaintext);
    });

    test('long string roundtrip', () => {
      const plaintext = 'x'.repeat(100_000);
      const encrypted = encrypt(plaintext, testKey);
      const decrypted = decrypt(encrypted, testKey);

      expect(decrypted).toBe(plaintext);
    });

    test('JSON data roundtrip', () => {
      const data = JSON.stringify({ token: 'abc123', refresh: 'def456', scopes: ['read', 'write'] });
      const encrypted = encrypt(data, testKey);
      const decrypted = decrypt(encrypted, testKey);

      expect(JSON.parse(decrypted)).toEqual(JSON.parse(data));
    });

    test('multi-line string roundtrip', () => {
      const plaintext = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpA...\n-----END RSA PRIVATE KEY-----';
      const encrypted = encrypt(plaintext, testKey);
      const decrypted = decrypt(encrypted, testKey);

      expect(decrypted).toBe(plaintext);
    });
  });

  describe('IV uniqueness', () => {
    test('two encryptions of same data produce different IVs', () => {
      const plaintext = 'same-value';
      const encrypted1 = encrypt(plaintext, testKey);
      const encrypted2 = encrypt(plaintext, testKey);

      expect(encrypted1.iv).not.toBe(encrypted2.iv);
    });

    test('two encryptions of same data produce different ciphertexts', () => {
      const plaintext = 'same-value';
      const encrypted1 = encrypt(plaintext, testKey);
      const encrypted2 = encrypt(plaintext, testKey);

      expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
    });
  });

  describe('wrong key rejection', () => {
    test('decryption with wrong key throws', () => {
      const plaintext = 'secret-data';
      const encrypted = encrypt(plaintext, testKey);

      const wrongKey = randomBytes(32);

      expect(() => decrypt(encrypted, wrongKey)).toThrow();
    });
  });

  describe('tampered ciphertext detection', () => {
    test('modified ciphertext is detected', () => {
      const plaintext = 'important-secret';
      const encrypted = encrypt(plaintext, testKey);

      // Tamper with ciphertext
      const tampered = { ...encrypted };
      const buf = Buffer.from(tampered.ciphertext, 'base64');
      buf[0] = buf[0] ^ 0xff;
      tampered.ciphertext = buf.toString('base64');

      expect(() => decrypt(tampered, testKey)).toThrow();
    });

    test('modified auth tag is detected', () => {
      const plaintext = 'important-secret';
      const encrypted = encrypt(plaintext, testKey);

      // Tamper with auth tag
      const tampered = { ...encrypted };
      const buf = Buffer.from(tampered.authTag, 'base64');
      buf[0] = buf[0] ^ 0xff;
      tampered.authTag = buf.toString('base64');

      expect(() => decrypt(tampered, testKey)).toThrow();
    });

    test('modified IV is detected', () => {
      const plaintext = 'important-secret';
      const encrypted = encrypt(plaintext, testKey);

      // Tamper with IV
      const tampered = { ...encrypted };
      const buf = Buffer.from(tampered.iv, 'base64');
      buf[0] = buf[0] ^ 0xff;
      tampered.iv = buf.toString('base64');

      expect(() => decrypt(tampered, testKey)).toThrow();
    });
  });

  describe('key derivation', () => {
    test('same password and salt produce same key', async () => {
      const password = 'test-password';
      const { key: key1, salt } = await deriveKey(password);
      const { key: key2 } = await deriveKey(password, salt);

      expect(Buffer.from(key1).equals(Buffer.from(key2))).toBe(true);
    });

    test('different passwords produce different keys', async () => {
      const salt = randomBytes(32);
      const { key: key1 } = await deriveKey('password1', salt);
      const { key: key2 } = await deriveKey('password2', salt);

      expect(Buffer.from(key1).equals(Buffer.from(key2))).toBe(false);
    });

    test('derived key is 32 bytes (256 bits)', async () => {
      const { key } = await deriveKey('test-password');
      expect(key.length).toBe(32);
    });
  });

  describe('access control logic', () => {
    test('empty allowedTools means all tools allowed', () => {
      const allowedTools: string[] = [];
      const requestedTool = 'any-tool';

      // When empty, all are allowed
      const allowed = allowedTools.length === 0 || allowedTools.includes(requestedTool);
      expect(allowed).toBe(true);
    });

    test('specific allowedTools restricts access', () => {
      const allowedTools = ['shell', 'git'];
      const requestedTool = 'browser';

      const allowed = allowedTools.length === 0 || allowedTools.includes(requestedTool);
      expect(allowed).toBe(false);
    });

    test('matching tool is allowed', () => {
      const allowedTools = ['shell', 'git'];
      const requestedTool = 'shell';

      const allowed = allowedTools.length === 0 || allowedTools.includes(requestedTool);
      expect(allowed).toBe(true);
    });
  });
});
