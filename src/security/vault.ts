import { eq, and } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { vault, type VaultEntry, type NewVaultEntry, SECRET_PLACEHOLDER_PATTERN } from '@/db/schema/vault';
import { auditRepository } from '@/db/repositories/audit-repository';
import { encrypt, decrypt } from '@/utils/crypto';
import { createHash } from 'crypto';
import { getConfig } from '@/config';
import { securityLogger } from '@/utils/logger';

let masterKey: Buffer | null = null;

/**
 * Initialize the vault with the master key
 */
export async function initializeVault(): Promise<void> {
  const config = getConfig();

  if (!config.security.masterKey) {
    throw new Error('Master key not configured');
  }

  // Derive a deterministic 256-bit key from the master key via SHA-256.
  // Unlike deriveKey() which uses a random salt, this is stable across restarts.
  masterKey = createHash('sha256').update(config.security.masterKey).digest();

  securityLogger.info('Vault initialized');
}

/**
 * Get the master key (throws if not initialized)
 */
function getMasterKey(): Buffer {
  if (!masterKey) {
    throw new Error('Vault not initialized. Call initializeVault() first.');
  }
  return masterKey;
}

export class Vault {
  private db = getDb();

  /**
   * Store a credential
   */
  async store(
    userId: string,
    name: string,
    value: string,
    options: {
      credentialType: NewVaultEntry['credentialType'];
      description?: string;
      tags?: string[];
      allowedSkills?: string[];
      allowedAgents?: string[];
      expiresAt?: Date;
      metadata?: Record<string, unknown>;
    }
  ): Promise<VaultEntry> {
    const key = getMasterKey();
    const encrypted = encrypt(value, key);

    const entry: NewVaultEntry = {
      userId,
      name,
      credentialType: options.credentialType,
      encryptedValue: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionAuthTag: encrypted.authTag,
      description: options.description,
      tags: options.tags || [],
      allowedSkills: options.allowedSkills || [],
      allowedAgents: options.allowedAgents || [],
      expiresAt: options.expiresAt,
      metadata: options.metadata || {},
    };

    const result = await this.db.insert(vault).values(entry).returning();

    await auditRepository.log({
      userId,
      action: 'credential_created',
      resourceType: 'credential',
      resourceId: result[0].id,
      details: { name, credentialType: options.credentialType },
    });

    securityLogger.info({ userId, name, type: options.credentialType }, 'Credential stored');

    return result[0];
  }

  /**
   * Retrieve a credential by ID
   */
  async get(userId: string, credentialId: string): Promise<string | null> {
    const entry = await this.db
      .select()
      .from(vault)
      .where(and(eq(vault.id, credentialId), eq(vault.userId, userId), eq(vault.isActive, true)))
      .limit(1);

    if (!entry[0]) {
      return null;
    }

    // Check expiration
    if (entry[0].expiresAt && entry[0].expiresAt < new Date()) {
      securityLogger.warn({ credentialId }, 'Credential expired');
      return null;
    }

    const key = getMasterKey();
    const decrypted = decrypt(
      {
        ciphertext: entry[0].encryptedValue,
        iv: entry[0].encryptionIv,
        authTag: entry[0].encryptionAuthTag,
      },
      key
    );

    // Update access tracking
    await this.db
      .update(vault)
      .set({
        lastAccessedAt: new Date(),
        accessCount: String(parseInt(entry[0].accessCount || '0', 10) + 1),
      })
      .where(eq(vault.id, credentialId));

    await auditRepository.logCredentialAccessed(userId, credentialId);

    return decrypted;
  }

  /**
   * Retrieve a credential by name
   */
  async getByName(userId: string, name: string): Promise<string | null> {
    const entry = await this.db
      .select()
      .from(vault)
      .where(and(eq(vault.name, name), eq(vault.userId, userId), eq(vault.isActive, true)))
      .limit(1);

    if (!entry[0]) {
      return null;
    }

    return this.get(userId, entry[0].id);
  }

  /**
   * List all credentials for a user (metadata only, not values)
   */
  async list(userId: string): Promise<Omit<VaultEntry, 'encryptedValue' | 'encryptionIv' | 'encryptionAuthTag'>[]> {
    const entries = await this.db
      .select({
        id: vault.id,
        userId: vault.userId,
        name: vault.name,
        credentialType: vault.credentialType,
        description: vault.description,
        tags: vault.tags,
        metadata: vault.metadata,
        allowedSkills: vault.allowedSkills,
        allowedAgents: vault.allowedAgents,
        isActive: vault.isActive,
        expiresAt: vault.expiresAt,
        lastAccessedAt: vault.lastAccessedAt,
        accessCount: vault.accessCount,
        createdAt: vault.createdAt,
        updatedAt: vault.updatedAt,
      })
      .from(vault)
      .where(eq(vault.userId, userId));

    return entries;
  }

  /**
   * Update a credential
   */
  async update(
    userId: string,
    credentialId: string,
    updates: {
      value?: string;
      description?: string;
      tags?: string[];
      allowedSkills?: string[];
      allowedAgents?: string[];
      expiresAt?: Date;
      metadata?: Record<string, unknown>;
    }
  ): Promise<VaultEntry | null> {
    const updateData: Partial<NewVaultEntry> = {};

    if (updates.value) {
      const key = getMasterKey();
      const encrypted = encrypt(updates.value, key);
      updateData.encryptedValue = encrypted.ciphertext;
      updateData.encryptionIv = encrypted.iv;
      updateData.encryptionAuthTag = encrypted.authTag;
    }

    if (updates.description !== undefined) updateData.description = updates.description;
    if (updates.tags) updateData.tags = updates.tags;
    if (updates.allowedSkills) updateData.allowedSkills = updates.allowedSkills;
    if (updates.allowedAgents) updateData.allowedAgents = updates.allowedAgents;
    if (updates.expiresAt !== undefined) updateData.expiresAt = updates.expiresAt;
    if (updates.metadata) updateData.metadata = updates.metadata;

    const result = await this.db
      .update(vault)
      .set({ ...updateData, updatedAt: new Date() })
      .where(and(eq(vault.id, credentialId), eq(vault.userId, userId)))
      .returning();

    if (result[0]) {
      await auditRepository.log({
        userId,
        action: 'credential_updated',
        resourceType: 'credential',
        resourceId: credentialId,
      });

      securityLogger.info({ userId, credentialId }, 'Credential updated');
    }

    return result[0] ?? null;
  }

  /**
   * Delete (deactivate) a credential
   */
  async delete(userId: string, credentialId: string): Promise<boolean> {
    const result = await this.db
      .update(vault)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(vault.id, credentialId), eq(vault.userId, userId)))
      .returning();

    if (result.length > 0) {
      await auditRepository.log({
        userId,
        action: 'credential_deleted',
        resourceType: 'credential',
        resourceId: credentialId,
      });

      securityLogger.info({ userId, credentialId }, 'Credential deleted');
      return true;
    }

    return false;
  }

  /**
   * Check if a skill/agent can access a credential
   */
  async canAccess(
    userId: string,
    credentialId: string,
    options: { skillId?: string; agentId?: string }
  ): Promise<boolean> {
    const entry = await this.db
      .select()
      .from(vault)
      .where(and(eq(vault.id, credentialId), eq(vault.userId, userId), eq(vault.isActive, true)))
      .limit(1);

    if (!entry[0]) {
      return false;
    }

    // Check expiration
    if (entry[0].expiresAt && entry[0].expiresAt < new Date()) {
      return false;
    }

    // Check skill permission
    const allowedSkills = entry[0].allowedSkills || [];
    if (allowedSkills.length > 0 && options.skillId && !allowedSkills.includes(options.skillId)) {
      return false;
    }

    // Check agent permission
    const allowedAgents = entry[0].allowedAgents || [];
    if (allowedAgents.length > 0 && options.agentId && !allowedAgents.includes(options.agentId)) {
      return false;
    }

    return true;
  }

  /**
   * Check if a skill/agent can access a credential by name
   */
  async canAccessByName(
    userId: string,
    name: string,
    options: { skillId?: string; agentId?: string }
  ): Promise<boolean> {
    const entry = await this.db
      .select()
      .from(vault)
      .where(and(eq(vault.name, name), eq(vault.userId, userId), eq(vault.isActive, true)))
      .limit(1);

    if (!entry[0]) {
      return false;
    }

    return this.canAccess(userId, entry[0].id, options);
  }

  /**
   * Rotate a credential value
   */
  async rotate(userId: string, credentialId: string, newValue: string): Promise<boolean> {
    const key = getMasterKey();
    const encrypted = encrypt(newValue, key);

    const result = await this.db
      .update(vault)
      .set({
        encryptedValue: encrypted.ciphertext,
        encryptionIv: encrypted.iv,
        encryptionAuthTag: encrypted.authTag,
        updatedAt: new Date(),
      })
      .where(and(eq(vault.id, credentialId), eq(vault.userId, userId), eq(vault.isActive, true)))
      .returning();

    if (result.length > 0) {
      securityLogger.info({ userId, credentialId }, 'Credential rotated');
      return true;
    }

    return false;
  }

  /**
   * Convenience method: get a system-level secret by name.
   * System secrets are stored with userId='system'.
   */
  async getSystemSecret(name: string): Promise<string | null> {
    try {
      return await this.getByName('system', name);
    } catch (error) {
      securityLogger.warn({ error, name }, 'Failed to retrieve system secret');
      return null;
    }
  }

  /**
   * Convenience method: store or update a system-level secret.
   */
  async setSystemSecret(name: string, value: string, options?: {
    description?: string;
    tags?: string[];
  }): Promise<VaultEntry> {
    // Check if it already exists
    const existing = await this.db
      .select()
      .from(vault)
      .where(and(eq(vault.name, name), eq(vault.userId, 'system'), eq(vault.isActive, true)))
      .limit(1);

    if (existing[0]) {
      const updated = await this.update('system', existing[0].id, {
        value,
        description: options?.description,
        tags: options?.tags,
      });
      return updated!;
    }

    return this.store('system', name, value, {
      credentialType: 'api_key',
      description: options?.description || `System secret: ${name}`,
      tags: options?.tags || ['system', 'auto-configured'],
    });
  }
}

// Singleton instance
let vaultInstance: Vault | null = null;

export function getVault(): Vault {
  if (!vaultInstance) {
    vaultInstance = new Vault();
  }
  return vaultInstance;
}
