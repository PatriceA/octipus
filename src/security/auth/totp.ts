import { authenticator } from 'otplib';
import { userRepository } from '@/db/repositories/user-repository';
import { auditRepository } from '@/db/repositories/audit-repository';
import { getConfig } from '@/config';
import { securityLogger } from '@/utils/logger';
import { encrypt, decrypt, deriveKey } from '@/utils/crypto';
import crypto from 'crypto';

// Configure TOTP
authenticator.options = {
  window: 1, // Allow 1 step before/after current
  step: 30, // 30 second intervals
  digits: 6,
};

let encryptionKey: Buffer | null = null;

async function getEncryptionKey(): Promise<Buffer> {
  if (encryptionKey) {
    return encryptionKey;
  }

  const config = getConfig();
  const { key } = await deriveKey(config.security.masterKey);
  encryptionKey = key;
  return key;
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
    const secret = authenticator.generateSecret();

    // Generate QR code URL
    const qrCodeUrl = authenticator.keyuri(user.username, this.issuer, secret);

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
    const isValid = authenticator.verify({ token: code, secret });

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

    // Try regular TOTP code
    if (authenticator.verify({ token: code, secret })) {
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
    if (!authenticator.verify({ token: code, secret })) {
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
