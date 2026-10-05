import { createHash, pbkdf2Sync } from 'crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { auditRepository } from '@/db/repositories/audit-repository';
import { type NewVaultEntry, type VaultEntry, type VaultScope, vault } from '@/db/schema/vault';
import { decrypt, deriveDek, encrypt } from '@/utils/crypto';
import { securityLogger } from '@/utils/logger';

/** Master key in raw form — held in memory only so HKDF can derive
 *  per-user DEKs on demand. Phase 1b-2 onwards. */
let rawMasterKey: Buffer | null = null;
/** Legacy PBKDF2-derived key — `key_version=1` rows were encrypted
 *  with this. Kept indefinitely so old ciphertexts stay readable. */
let pbkdf2Key: Buffer | null = null;
/** Pre-PBKDF2 SHA-256(masterKey) key — even older rows. */
let legacyKey: Buffer | null = null;

/** New writes encrypt at this version. Bump to 3+ when introducing the
 *  next derivation scheme; old versions still decrypt via this file. */
const CURRENT_KEY_VERSION = 2;

/**
 * Initialize the vault with the master key.
 *
 * Computes both the legacy PBKDF2-derived key (used by `key_version=1`
 * rows) and the SHA-256 key (used by even older pre-PBKDF2 rows). The
 * raw master key is also retained so per-user DEKs can be derived on
 * demand for `key_version=2` rows.
 */
export async function initializeVault(): Promise<void> {
  const config = getConfig();

  if (!config.security.masterKey) {
    throw new Error('Master key not configured');
  }

  // Hold the raw master key so HKDF can derive per-user DEKs on demand.
  rawMasterKey = Buffer.from(config.security.masterKey);

  // Derive a deterministic 256-bit key from the master key via PBKDF2 with a
  // fixed salt and 100 000 iterations. Used for key_version=1 rows.
  pbkdf2Key = pbkdf2Sync(config.security.masterKey, 'assistant-vault-v1', 100_000, 32, 'sha256');

  // Keep the legacy SHA-256 key for backwards-compatible decryption of
  // secrets that were encrypted before the PBKDF2 migration.
  legacyKey = createHash('sha256').update(config.security.masterKey).digest();

  securityLogger.info('Vault initialized');
}

/** What a row's key derives from: its scope, owner and (for a space secret) space. */
export type VaultKeyRow = Pick<VaultEntry, 'scope' | 'userId' | 'workspaceId'>;

/**
 * The `key_version=2` DEK of a vault row, under `masterKey`. The one
 * derivation every decrypt, encrypt and rotation path uses (coworking §9.5):
 * a `space` row's key derives from its space (`workspace_id`) — the owner who
 * stored it is its author, not its key, so a space secret stays readable
 * whoever of its owners stored it and after that owner leaves — and every
 * other row's from `(scope, user_id)`, as before.
 */
export function dekForRow(row: VaultKeyRow, masterKey: Buffer): Buffer {
  if (row.scope === 'space') {
    if (!row.workspaceId) throw new Error('A space secret has no workspace_id');
    return deriveDek(masterKey, 'space', row.workspaceId);
  }
  return deriveDek(masterKey, row.scope, row.userId);
}

/** `dekForRow` under the running master key. Deterministic, so never persisted. */
function dekFor(row: VaultKeyRow): Buffer {
  if (!rawMasterKey) {
    throw new Error('Vault not initialized. Call initializeVault() first.');
  }
  return dekForRow(row, rawMasterKey);
}

/** Legacy PBKDF2 key (key_version=1). */
function getPbkdf2Key(): Buffer {
  if (!pbkdf2Key) {
    throw new Error('Vault not initialized. Call initializeVault() first.');
  }
  return pbkdf2Key;
}

/**
 * Reset the vault state — test-only helper. Resets the cached master
 * keys so a subsequent `initializeVault()` re-derives them. Production
 * code never calls this.
 */
export function _resetVaultForTests(): void {
  rawMasterKey = null;
  pbkdf2Key = null;
  legacyKey = null;
}

/**
 * Resolve the implicit scope from a userId. The legacy API took raw
 * userId strings including the `'system'` sentinel; the schema now
 * carries a typed `scope` column. Until every caller passes scope
 * explicitly we infer it here on insert / read so old code paths keep
 * working without behavior changes.
 */
function inferScope(userId: string): VaultScope {
  return userId === 'system' ? 'system' : 'user';
}

/**
 * Re-encrypt a single vault row from the OLD master key to a NEW one.
 *
 * Used by `scripts/rotate-master-key.ts` and exposed here so the
 * crypto plumbing has a single home. Both master keys are passed
 * explicitly — this function deliberately does NOT touch the
 * cached module-level keys, so it can run safely while a normal
 * server is not yet aware of the new key.
 *
 * The re-encryption path is identical to the lazy v1→v2 upgrade in
 * `vault.get` but with a different DEK derivation: the old DEK is
 * derived from `oldMasterKey`, the new DEK from `newMasterKey`. Both
 * come from `dekForRow`, so the row keeps its per-(scope, user) — or,
 * for a space secret, per-space — isolation across the rotation.
 *
 * Returns:
 *   - 'rotated'   on a successful rewrite (default; row was at v2
 *                 and old master decrypted it).
 *   - 'skipped'   if the row was already encrypted under the new
 *                 master (happens on a re-run; the function is
 *                 idempotent).
 *   - 'failed'    on decrypt failure with both masters.
 *
 * Errors raised by Postgres on the UPDATE are not caught — the
 * caller (rotation script) reports per-row failures and moves on.
 */
export async function rotateVaultRowMasterKey(
  rowId: string,
  oldMasterKey: Buffer,
  newMasterKey: Buffer,
): Promise<'rotated' | 'skipped' | 'failed'> {
  const db = getDb();
  const [row] = await db.select().from(vault).where(eq(vault.id, rowId)).limit(1);
  if (!row) return 'failed';

  const oldDek = dekForRow(row, oldMasterKey);
  const newDek = dekForRow(row, newMasterKey);

  const encData = {
    ciphertext: row.encryptedValue,
    iv: row.encryptionIv,
    authTag: row.encryptionAuthTag,
  };

  // Try the OLD master first. If it decrypts → re-encrypt with new.
  let plaintext: string | null = null;
  try {
    plaintext = decrypt(encData, oldDek);
  } catch {
    // Idempotency: maybe this row was already rotated by an earlier
    // run that crashed mid-batch. Try decrypting with the NEW key —
    // success means there's nothing to do.
    try {
      decrypt(encData, newDek);
      return 'skipped';
    } catch {
      return 'failed';
    }
  }

  const reEncrypted = encrypt(plaintext, newDek);
  await db.update(vault).set({
    encryptedValue: reEncrypted.ciphertext,
    encryptionIv: reEncrypted.iv,
    encryptionAuthTag: reEncrypted.authTag,
    keyVersion: CURRENT_KEY_VERSION,
    updatedAt: new Date(),
  }).where(eq(vault.id, rowId));

  return 'rotated';
}

type VaultCiphertextRow = VaultKeyRow & Pick<VaultEntry, 'keyVersion' | 'encryptedValue' | 'encryptionIv' | 'encryptionAuthTag'>;

/**
 * Decrypt a vault row under its recorded key version, falling through
 * every older scheme when the column and the ciphertext disagree.
 *   2: HKDF DEK of the row itself (`dekForRow`): its scope and owner, or its space.
 *   1: legacy PBKDF2 key (single key for every row).
 *   0/missing: even older SHA-256(masterKey) — pre-PBKDF2 migration.
 * `needsReencrypt` is true when the row should be rewritten at
 * CURRENT_KEY_VERSION. Throws when no scheme decrypts it.
 */
export function decryptRow(row: VaultCiphertextRow): { plaintext: string; needsReencrypt: boolean } {
  const encData = {
    ciphertext: row.encryptedValue,
    iv: row.encryptionIv,
    authTag: row.encryptionAuthTag,
  };
  const tryAt = (k: Buffer): string | null => {
    try { return decrypt(encData, k); } catch { return null; }
  };

  let decrypted: string | null = null;
  let needsReencrypt = false;
  if (row.keyVersion === 2) {
    decrypted = tryAt(dekFor(row));
  } else if (row.keyVersion === 1) {
    decrypted = tryAt(getPbkdf2Key());
    needsReencrypt = decrypted !== null;
  }
  if (decrypted === null) {
    // Fall back through every older scheme just in case the column is
    // out of sync with the actual ciphertext (e.g. partial migration).
    decrypted = tryAt(dekFor(row));
    if (decrypted === null) decrypted = tryAt(getPbkdf2Key());
    if (decrypted === null && legacyKey) decrypted = tryAt(legacyKey);
    if (decrypted !== null) needsReencrypt = true;
  }
  if (decrypted === null) {
    throw new Error('Decryption failed across all known key versions');
  }
  return { plaintext: decrypted, needsReencrypt };
}

/** The ciphertext columns of `plaintext` sealed for `row` at the current key version. */
export function encryptForRow(
  row: VaultKeyRow,
  plaintext: string,
): Pick<VaultEntry, 'encryptedValue' | 'encryptionIv' | 'encryptionAuthTag' | 'keyVersion'> {
  const encrypted = encrypt(trimSecret(plaintext), dekFor(row));
  return {
    encryptedValue: encrypted.ciphertext,
    encryptionIv: encrypted.iv,
    encryptionAuthTag: encrypted.authTag,
    keyVersion: CURRENT_KEY_VERSION,
  };
}

/**
 * Rewrite one row at the current key version, whatever its scope (the
 * `rotate-vault-keys` script). `'current'` when it already is, `'upgraded'`
 * after the rewrite, `'missing'` for no such row. Throws when no scheme
 * decrypts it, leaving the row as it was.
 */
export async function upgradeVaultRow(rowId: string): Promise<'upgraded' | 'current' | 'missing'> {
  const db = getDb();
  const [row] = await db.select().from(vault).where(eq(vault.id, rowId)).limit(1);
  if (!row) return 'missing';
  const { plaintext, needsReencrypt } = decryptRow(row);
  if (!needsReencrypt && row.keyVersion === CURRENT_KEY_VERSION) return 'current';
  await db.update(vault).set({ ...encryptForRow(row, plaintext), updatedAt: new Date() }).where(eq(vault.id, rowId));
  return 'upgraded';
}

/**
 * Re-encrypt a row for a new owner: decrypt under the row's current
 * `(scope, userId)` and encrypt under `(scope, newUserId)`. Workspace
 * transfer rewrites `user_id` on workspace secrets; without this the
 * recipient's DEK could never open them. Returns the columns to write —
 * the caller writes them together with the new `user_id` in its own
 * transaction.
 */
export function reencryptVaultRowForOwner(
  row: VaultCiphertextRow,
  newUserId: string,
): Pick<VaultEntry, 'encryptedValue' | 'encryptionIv' | 'encryptionAuthTag' | 'keyVersion'> {
  if (row.scope === 'space') throw new Error('A space secret has no owner to re-encrypt for: its key is the space');
  const { plaintext } = decryptRow(row);
  const encrypted = encrypt(plaintext, dekFor({ ...row, userId: newUserId }));
  return {
    encryptedValue: encrypted.ciphertext,
    encryptionIv: encrypted.iv,
    encryptionAuthTag: encrypted.authTag,
    keyVersion: CURRENT_KEY_VERSION,
  };
}

/**
 * Surrounding whitespace is never part of a credential.
 *
 * A key pasted out of a file or a terminal carries a trailing newline, and the
 * stored value is then byte-for-byte wrong while looking identical in every UI
 * that renders it. The failure it produces is the least informative one there
 * is — the provider answers `401 Invalid API key` for a key the user can see
 * working elsewhere. Inner newlines are preserved, so multi-line secrets (PEM
 * blocks) are unaffected.
 */
function trimSecret(value: string): string {
  return value.trim();
}

export class Vault {
  private get db() { return getDb(); }

  /**
   * Store a credential. Scope is inferred from userId
   * (`'system'` → `system`, otherwise `user`); pass `scope` explicitly
   * to override (for the future workspace tier).
   */
  async store(
    userId: string,
    name: string,
    value: string,
    options: {
      credentialType: NewVaultEntry['credentialType'];
      description?: string;
      tags?: string[];
      allowedTools?: string[];
      allowedAgents?: string[];
      expiresAt?: Date;
      metadata?: Record<string, unknown>;
      scope?: VaultScope;
      /**
       * Phase 4 follow-up — bind the secret to a workspace owned by
       * `userId`. Only meaningful when `scope === 'workspace'`; ignored
       * otherwise. Reads filter on this column when the request
       * principal carries a workspace context.
       */
      workspaceId?: string | null;
    }
  ): Promise<VaultEntry> {
    const scope = options.scope ?? inferScope(userId);
    // Space secrets are written by the space access layer only (§9.5).
    if (scope === 'space') throw new Error('Space secrets are stored through the space access layer');
    const workspaceId = scope === 'workspace' ? (options.workspaceId ?? null) : null;
    const dek = dekFor({ scope, userId, workspaceId });
    const encrypted = encrypt(trimSecret(value), dek);

    const entry: NewVaultEntry = {
      userId,
      scope,
      workspaceId,
      name,
      credentialType: options.credentialType,
      encryptedValue: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionAuthTag: encrypted.authTag,
      keyVersion: CURRENT_KEY_VERSION,
      description: options.description,
      tags: options.tags || [],
      allowedTools: options.allowedTools || [],
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
      details: { name, credentialType: options.credentialType, scope: entry.scope },
    });

    securityLogger.info({ userId, name, type: options.credentialType, scope: entry.scope }, 'Credential stored');

    return result[0];
  }

  /**
   * Retrieve a credential by ID. Strict ownership: the row must match
   * BOTH the userId and the inferred scope. A `userId='system'` lookup
   * never resolves to a user-scoped row even if the id collides.
   */
  async get(userId: string, credentialId: string): Promise<string | null> {
    const scope = inferScope(userId);
    const entry = await this.db
      .select()
      .from(vault)
      .where(and(
        eq(vault.id, credentialId),
        eq(vault.userId, userId),
        eq(vault.scope, scope),
        eq(vault.isActive, true),
      ))
      .limit(1);

    if (!entry[0]) {
      return null;
    }
    return this.readEntry(userId, entry[0]);
  }

  /**
   * Decrypt a row the caller already selected under its own ownership
   * filter. The DEK comes from the row's own `(scope, userId)`, so a
   * `scope='workspace'` row decrypts here although `get()` (which infers
   * the scope from the caller) never selects one.
   */
  private async readEntry(userId: string, row: VaultEntry): Promise<string | null> {
    const credentialId = row.id;

    // Check expiration
    if (row.expiresAt && row.expiresAt < new Date()) {
      securityLogger.warn({ credentialId }, 'Credential expired');
      return null;
    }

    // The recorded key version first, then the older schemes. On a
    // successful fall-through we opportunistically re-encrypt the row at
    // CURRENT_KEY_VERSION so the next read is fast.
    const { plaintext: decrypted, needsReencrypt } = decryptRow(row);

    if (needsReencrypt) {
      // Opportunistic upgrade — write the row back at CURRENT_KEY_VERSION
      // so the next access takes the fast path. Failures here are
      // logged and swallowed: the read itself succeeded.
      try {
        const dek = dekFor(row);
        const reEncrypted = encrypt(decrypted, dek);
        await this.db.update(vault).set({
          encryptedValue: reEncrypted.ciphertext,
          encryptionIv: reEncrypted.iv,
          encryptionAuthTag: reEncrypted.authTag,
          keyVersion: CURRENT_KEY_VERSION,
          updatedAt: new Date(),
        }).where(eq(vault.id, credentialId));
        securityLogger.info(
          { credentialId, fromVersion: row.keyVersion, toVersion: CURRENT_KEY_VERSION },
          'Vault entry re-encrypted to current key version',
        );
      } catch (err) {
        securityLogger.warn({ err, credentialId }, 'Vault re-encryption failed; row stays at legacy key');
      }
    }

    // Update access tracking
    await this.db
      .update(vault)
      .set({
        lastAccessedAt: new Date(),
        accessCount: String(parseInt(row.accessCount || '0', 10) + 1),
      })
      .where(eq(vault.id, credentialId));

    await auditRepository.logCredentialAccessed(userId, credentialId);

    return decrypted;
  }

  /**
   * Retrieve a credential by name within the implicit scope of `userId`.
   * Strict: looking up `userId='system'` only returns scope='system'
   * rows. Looking up a user UUID only returns that user's rows.
   */
  /**
   * Look up a credential by name. When `opts.workspaceId` is set,
   * also matches `scope='workspace'` rows bound to exactly that
   * workspace (a workspace row without a workspace belongs to none),
   * and such a row wins over a same-named user row. The row is
   * decrypted under its own scope and owner, not the caller's
   * inferred scope.
   */
  async getByName(
    userId: string,
    name: string,
    opts?: { workspaceId?: string | null },
  ): Promise<string | null> {
    const scope = inferScope(userId);
    const workspaceId = opts?.workspaceId ?? null;
    // Broadened scope filter when caller supplies a workspace
    // context: user-scoped rows always visible, workspace-scoped
    // rows narrow on the column.
    const scopeFilter = workspaceId
      ? sql`(${vault.scope} = ${scope} OR (${vault.scope} = 'workspace' AND ${vault.workspaceId} = ${workspaceId}))`
      : eq(vault.scope, scope);

    const entry = await this.db
      .select()
      .from(vault)
      .where(and(
        eq(vault.name, name),
        eq(vault.userId, userId),
        scopeFilter,
        eq(vault.isActive, true),
      ))
      .orderBy(desc(vault.scope)) // 'workspace' > 'user' > 'system' lexicographically; workspace overrides win
      .limit(1);

    if (!entry[0]) {
      return null;
    }

    return this.readEntry(userId, entry[0]);
  }

  /**
   * List all credentials for a user (metadata only, not values).
   * Returns rows whose `(user_id, scope)` matches the inferred scope —
   * `userId='system'` gets system-scoped rows; a UUID gets that user's
   * own rows.
   */
  async list(
    userId: string,
    opts?: { workspaceId?: string | null },
  ): Promise<Omit<VaultEntry, 'encryptedValue' | 'encryptionIv' | 'encryptionAuthTag'>[]> {
    const scope = inferScope(userId);
    const workspaceId = opts?.workspaceId ?? null;
    // Same rule as getByName: a workspace row shows only in its own workspace.
    const scopeFilter = workspaceId
      ? sql`(${vault.scope} = ${scope} OR (${vault.scope} = 'workspace' AND ${vault.workspaceId} = ${workspaceId}))`
      : eq(vault.scope, scope);

    const entries = await this.db
      .select({
        id: vault.id,
        userId: vault.userId,
        scope: vault.scope,
        workspaceId: vault.workspaceId,
        name: vault.name,
        credentialType: vault.credentialType,
        keyVersion: vault.keyVersion,
        description: vault.description,
        tags: vault.tags,
        metadata: vault.metadata,
        allowedTools: vault.allowedTools,
        allowedAgents: vault.allowedAgents,
        isActive: vault.isActive,
        expiresAt: vault.expiresAt,
        lastAccessedAt: vault.lastAccessedAt,
        accessCount: vault.accessCount,
        createdAt: vault.createdAt,
        updatedAt: vault.updatedAt,
      })
      .from(vault)
      .where(and(
        eq(vault.userId, userId),
        scopeFilter,
        eq(vault.isActive, true),
      ));

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
      allowedTools?: string[];
      allowedAgents?: string[];
      expiresAt?: Date;
      metadata?: Record<string, unknown>;
    }
  ): Promise<VaultEntry | null> {
    const updateData: Partial<NewVaultEntry> = {};

    if (updates.value) {
      const scope = inferScope(userId);
      const dek = dekFor({ scope, userId, workspaceId: null });
      const encrypted = encrypt(trimSecret(updates.value), dek);
      updateData.encryptedValue = encrypted.ciphertext;
      updateData.encryptionIv = encrypted.iv;
      updateData.encryptionAuthTag = encrypted.authTag;
      updateData.keyVersion = CURRENT_KEY_VERSION;
    }

    if (updates.description !== undefined) updateData.description = updates.description;
    if (updates.tags) updateData.tags = updates.tags;
    if (updates.allowedTools) updateData.allowedTools = updates.allowedTools;
    if (updates.allowedAgents) updateData.allowedAgents = updates.allowedAgents;
    if (updates.expiresAt !== undefined) updateData.expiresAt = updates.expiresAt;
    if (updates.metadata) updateData.metadata = updates.metadata;

    const scope = inferScope(userId);
    const result = await this.db
      .update(vault)
      .set({ ...updateData, updatedAt: new Date() })
      .where(and(eq(vault.id, credentialId), eq(vault.userId, userId), eq(vault.scope, scope)))
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
    const scope = inferScope(userId);
    const result = await this.db
      .update(vault)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(vault.id, credentialId), eq(vault.userId, userId), eq(vault.scope, scope)))
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
   * Check if a tool/agent can access a credential
   */
  async canAccess(
    userId: string,
    credentialId: string,
    options: { toolId?: string; agentId?: string }
  ): Promise<boolean> {
    const scope = inferScope(userId);
    const entry = await this.db
      .select()
      .from(vault)
      .where(and(
        eq(vault.id, credentialId),
        eq(vault.userId, userId),
        eq(vault.scope, scope),
        eq(vault.isActive, true),
      ))
      .limit(1);

    if (!entry[0]) {
      return false;
    }

    // Check expiration
    if (entry[0].expiresAt && entry[0].expiresAt < new Date()) {
      return false;
    }

    // Check tool permission
    const allowedTools = entry[0].allowedTools || [];
    if (allowedTools.length > 0 && options.toolId && !allowedTools.includes(options.toolId)) {
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
   * Check if a tool/agent can access a credential by name
   */
  async canAccessByName(
    userId: string,
    name: string,
    options: { toolId?: string; agentId?: string }
  ): Promise<boolean> {
    const scope = inferScope(userId);
    const entry = await this.db
      .select()
      .from(vault)
      .where(and(
        eq(vault.name, name),
        eq(vault.userId, userId),
        eq(vault.scope, scope),
        eq(vault.isActive, true),
      ))
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
    const scope = inferScope(userId);
    const dek = dekFor({ scope, userId, workspaceId: null });
    const encrypted = encrypt(newValue, dek);

    const result = await this.db
      .update(vault)
      .set({
        encryptedValue: encrypted.ciphertext,
        encryptionIv: encrypted.iv,
        encryptionAuthTag: encrypted.authTag,
        keyVersion: CURRENT_KEY_VERSION,
        updatedAt: new Date(),
      })
      .where(and(
        eq(vault.id, credentialId),
        eq(vault.userId, userId),
        eq(vault.scope, scope),
        eq(vault.isActive, true),
      ))
      .returning();

    if (result.length > 0) {
      securityLogger.info({ userId, credentialId }, 'Credential rotated');
      return true;
    }

    return false;
  }

  /**
   * Convenience method: get a system-level secret by name.
   *
   * Phase 1b-1: STRICT — returns only `scope='system'` rows.
   * Pre-Phase-1b this method had a fallback that scanned ALL users'
   * secrets; that was a cross-tenant leak (any code calling
   * `getSystemSecret('openai_api_key')` could surface another user's
   * private secret if no system row existed). The fallback is gone.
   * If callers rely on per-user keys for the same logical secret they
   * must use `getForAgent` with a Principal-bound context.
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
    // Check if it already exists (system-scoped only)
    const existing = await this.db
      .select()
      .from(vault)
      .where(and(
        eq(vault.name, name),
        eq(vault.userId, 'system'),
        eq(vault.scope, 'system'),
        eq(vault.isActive, true),
      ))
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

  /**
   * Resolve a secret on behalf of an agent / tool execution.
   *
   * Lookup order:
   *   1. user-scoped row owned by `agent.userId` with the same `name`
   *      and `(allowedTools, allowedAgents)` allowing this caller.
   *   2. system-scoped row with the same `name` and allowlist passing.
   *
   * Never a `workspace` or `space` row: a space connector's secret is used
   * by connector code only (coworking §9.5), so `{{secret:NAME}}` cannot
   * route it into a shell command or an HTTP request.
   *
   * Returns `null` if neither resolves OR if the matching row's
   * allowlist excludes the calling tool/agent. The allowlist check is
   * the same one that gates `canAccess`; surfacing it here means a
   * single call site is enough for the secret-injector.
   *
   * This is the scope-aware replacement for the legacy injector path
   * that called `getByName(userId, name)` directly. Phase 1b-1 leaves
   * `getByName` in place for backwards compat but the root agent
   * should migrate to `getForAgent` over time.
   */
  async getForAgent(
    agent: { userId: string; toolId?: string; agentId?: string },
    name: string,
  ): Promise<string | null> {
    // Try user scope first.
    if (agent.userId && agent.userId !== 'system') {
      const ok = await this.canAccessByName(agent.userId, name, {
        toolId: agent.toolId,
        agentId: agent.agentId,
      });
      if (ok) {
        const v = await this.getByName(agent.userId, name);
        if (v !== null) return v;
      }
    }
    // Fall back to system scope.
    const sysOk = await this.canAccessByName('system', name, {
      toolId: agent.toolId,
      agentId: agent.agentId,
    });
    if (sysOk) {
      return this.getByName('system', name);
    }
    return null;
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
