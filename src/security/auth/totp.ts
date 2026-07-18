import crypto from 'crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import { getConfig } from '@/config';
import { userRepository } from '@/db/repositories/user-repository';
import { decrypt, deriveDek, encrypt } from '@/utils/crypto';
import { securityLogger } from '@/utils/logger';

// otplib 13 moved from a stateful `authenticator` singleton to a stateless
// functional API. The old config was `{ window: 1, step: 30, digits: 6 }`:
// a ±1 step window over 30-second steps is a ±30s acceptance window, expressed
// here as `epochTolerance`. 30s step and 6 digits are the library defaults, so
// only the tolerance needs to be passed explicitly. Secrets stay Base32 (the
// default ScureBase32Plugin is RFC 4648 compatible), so existing enrolled
// secrets keep verifying.
const TOTP_EPOCH_TOLERANCE_SECONDS = 30;

/**
 * Verify a TOTP token, returning false (never throwing) for a malformed token.
 *
 * otplib 13's `verify` throws `TokenLengthError` when the token isn't 6 digits.
 * Login and `verify()` accept a single field that may hold EITHER a 6-digit
 * TOTP code OR an 8-character backup code, so the raw throw would (a) propagate
 * out of `verify()` before its backup-code fallback could run, making backup
 * codes unusable, and (b) surface as a 500 on the login route. Treating a
 * non-verifiable token as simply invalid lets the backup-code path take over.
 */
async function isValidTotpToken(token: string, secret: string): Promise<boolean> {
  try {
    const { valid } = await verify({ token, secret, epochTolerance: TOTP_EPOCH_TOLERANCE_SECONDS });
    return valid;
  } catch {
    return false;
  }
}

let encryptionKey: Buffer | null = null;

async function getEncryptionKey(): Promise<Buffer> {
  if (encryptionKey) {
    return encryptionKey;
  }

  const config = getConfig();
  // Deterministic HKDF derivation (same primitive the vault uses), keyed only
  // on the master key. The previous deriveKey() call generated a fresh random
  // scrypt salt on every process start and never persisted it, so after a
  // restart the derived key changed and every stored TOTP secret / backup code
  // failed to decrypt. deriveDek is stable across restarts.
  encryptionKey = deriveDek(Buffer.from(config.security.masterKey), 'totp', 'global');
  return encryptionKey;
}

export class TOTPAuth {
  private issuer: string;

  constructor() {
    const config = getConfig();
    this.issuer = config.security.totpIssuer;
  }

  /**
   * Generate a new TOTP secret for a user
   */
  async generateSecret(userId: string): Promise<{
    secret: string;
    qrCodeUrl: string;
    backupCodes: string[];
  }> {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    // Generate secret
    const secret = generateSecret();

    // Generate QR code URL
    const qrCodeUrl = generateURI({ issuer: this.issuer, label: user.username, secret });

    // Generate backup codes
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const backupCodes: string[] = [];
    for (let i = 0; i < 10; i++) {
      let code = '';
      for (let j = 0; j < 8; j++) {
        code += charset[crypto.randomInt(0, charset.length)];
      }
      backupCodes.push(code);
    }

    // Encrypt and store secret (not enabled until verified)
    const key = await getEncryptionKey();
    const encrypted = encrypt(JSON.stringify({ secret, backupCodes }), key);
    const encryptedValue = `${encrypted.iv}:${encrypted.authTag}:${encrypted.ciphertext}`;

    await userRepository.update(userId, {
      totpSecret: encryptedValue,
      totpEnabled: false,
    });

    securityLogger.info({ userId }, 'TOTP secret generated');

    return { secret, qrCodeUrl, backupCodes };
  }

  /**
   * Enable TOTP after verifying the initial code
   */
  async enable(userId: string, code: string): Promise<boolean> {
    const user = await userRepository.findById(userId);
    if (!user || !user.totpSecret) {
      throw new Error('TOTP not configured');
    }

    // Decrypt secret
    const key = await getEncryptionKey();
    const [iv, authTag, ciphertext] = user.totpSecret.split(':');
    const decrypted = decrypt({ iv, authTag, ciphertext }, key);
    const { secret } = JSON.parse(decrypted);

    // Verify code
    const isValid = await isValidTotpToken(code, secret);

    if (!isValid) {
      securityLogger.warn({ userId }, 'Invalid TOTP code during enable');
      return false;
    }

    await userRepository.update(userId, { totpEnabled: true });
    securityLogger.info({ userId }, 'TOTP enabled');

    return true;
  }

  /**
   * Verify a TOTP code
   */
  async verify(userId: string, code: string): Promise<boolean> {
    const user = await userRepository.findById(userId);
    if (!user || !user.totpSecret || !user.totpEnabled) {
      throw new Error('TOTP not enabled');
    }

    // Decrypt secret
    const key = await getEncryptionKey();
    const [iv, authTag, ciphertext] = user.totpSecret.split(':');
    const decrypted = decrypt({ iv, authTag, ciphertext }, key);
    const { secret, backupCodes } = JSON.parse(decrypted);

    // Try regular TOTP code (tolerant: a backup code is not a 6-digit token, so
    // this returns false and we fall through instead of throwing).
    const valid = await isValidTotpToken(code, secret);
    if (valid) {
      return true;
    }

    // Try backup code
    const upperCode = code.toUpperCase();
    const backupIndex = backupCodes.indexOf(upperCode);

    if (backupIndex !== -1) {
      // Remove used backup code
      backupCodes.splice(backupIndex, 1);

      // Re-encrypt with updated backup codes
      const encrypted = encrypt(JSON.stringify({ secret, backupCodes }), key);
      const encryptedValue = `${encrypted.iv}:${encrypted.authTag}:${encrypted.ciphertext}`;
      await userRepository.update(userId, { totpSecret: encryptedValue });

      securityLogger.info({ userId }, 'TOTP backup code used');
      return true;
    }

    securityLogger.warn({ userId }, 'Invalid TOTP code');
    return false;
  }

  /**
   * Disable TOTP for a user
   */
  async disable(userId: string, code: string): Promise<boolean> {
    // Verify code before disabling
    const isValid = await this.verify(userId, code);

    if (!isValid) {
      return false;
    }

    await userRepository.update(userId, {
      totpSecret: null,
      totpEnabled: false,
    });

    securityLogger.info({ userId }, 'TOTP disabled');
    return true;
  }

  /**
   * Check if TOTP is enabled for a user
   */
  async isEnabled(userId: string): Promise<boolean> {
    const user = await userRepository.findById(userId);
    return user?.totpEnabled || false;
  }

  /**
   * Get remaining backup codes count
   */
  async getBackupCodesCount(userId: string): Promise<number> {
    const user = await userRepository.findById(userId);
    if (!user || !user.totpSecret) {
      return 0;
    }

    try {
      const key = await getEncryptionKey();
      const [iv, authTag, ciphertext] = user.totpSecret.split(':');
      const decrypted = decrypt({ iv, authTag, ciphertext }, key);
      const { backupCodes } = JSON.parse(decrypted);
      return backupCodes.length;
    } catch {
      return 0;
    }
  }

  /**
   * Regenerate backup codes
   */
  async regenerateBackupCodes(userId: string, code: string): Promise<string[] | null> {
    // Verify current code
    const user = await userRepository.findById(userId);
    if (!user || !user.totpSecret || !user.totpEnabled) {
      return null;
    }

    const key = await getEncryptionKey();
    const [iv, authTag, ciphertext] = user.totpSecret.split(':');
    const decrypted = decrypt({ iv, authTag, ciphertext }, key);
    const { secret } = JSON.parse(decrypted);

    // Verify code
    const valid = await isValidTotpToken(code, secret);
    if (!valid) {
      return null;
    }

    // Generate new backup codes
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const backupCodes: string[] = [];
    for (let i = 0; i < 10; i++) {
      let newCode = '';
      for (let j = 0; j < 8; j++) {
        newCode += charset[crypto.randomInt(0, charset.length)];
      }
      backupCodes.push(newCode);
    }

    // Re-encrypt with new backup codes
    const encrypted = encrypt(JSON.stringify({ secret, backupCodes }), key);
    const encryptedValue = `${encrypted.iv}:${encrypted.authTag}:${encrypted.ciphertext}`;
    await userRepository.update(userId, { totpSecret: encryptedValue });

    securityLogger.info({ userId }, 'TOTP backup codes regenerated');
    return backupCodes;
  }
}

// Singleton instance
let totpAuthInstance: TOTPAuth | null = null;

export function getTOTPAuth(): TOTPAuth {
  if (!totpAuthInstance) {
    totpAuthInstance = new TOTPAuth();
  }
  return totpAuthInstance;
}
