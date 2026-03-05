import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getVault } from '@/security/vault';
import { apiLogger } from '@/utils/logger';

export const vaultRoutes = new Elysia({ prefix: '/vault' })
  .use(apiContext)
  // List credentials (metadata only)
  .get(
    '/',
    async ({ user }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const vault = getVault();
      const entries = await vault.list(user.id);
      // Admins also see system-level credentials, but avoid duplicates if user IS system
      const systemEntries = (user.isAdmin && user.id !== 'system') ? await vault.list('system') : [];
      return { credentials: [...entries, ...systemEntries] };
    },
    { detail: { tags: ['vault'] } }
  )

  // Create credential
  .post(
    '/',
    async ({ user, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const vault = getVault();
      // System-level credentials (e.g. OAuth client IDs) are stored under 'system' user
      const ownerId = body.systemLevel ? 'system' : user.id;

      // Check if credential already exists — update instead of creating duplicate
      const existing = await vault.getByName(ownerId, body.name);
      if (existing !== null) {
        // Find the entry to get its ID for update
        const entries = await vault.list(ownerId);
        const existingEntry = entries.find((e) => e.name === body.name);
        if (existingEntry) {
          const updated = await vault.update(ownerId, existingEntry.id, {
            value: body.value,
            description: body.description,
            tags: body.tags,
          });
          if (updated) {
            const { encryptedValue, encryptionIv, encryptionAuthTag, ...safe } = updated;
            return safe;
          }
        }
      }

      const entry = await vault.store(ownerId, body.name, body.value, {
        credentialType: body.credentialType,
        description: body.description,
        tags: body.tags,
        allowedTools: body.allowedTools,
        allowedAgents: body.allowedAgents,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
      });

      // Strip encryption fields
      const { encryptedValue, encryptionIv, encryptionAuthTag, ...safe } = entry;

      return safe;
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        value: t.String({ minLength: 1 }),
        credentialType: t.Union([
          t.Literal('api_key'),
          t.Literal('oauth_token'),
          t.Literal('password'),
          t.Literal('ssh_key'),
          t.Literal('certificate'),
          t.Literal('other'),
        ]),
        description: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
        allowedTools: t.Optional(t.Array(t.String())),
        allowedAgents: t.Optional(t.Array(t.String())),
        expiresAt: t.Optional(t.String()),
        systemLevel: t.Optional(t.Boolean()),
      }),
      detail: { tags: ['vault'] },
    }
  )

  // Update credential
  .patch(
    '/:id',
    async ({ user, params, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const vault = getVault();
      const entry = await vault.update(user.id, params.id, {
        value: body.value,
        description: body.description,
        tags: body.tags,
        allowedTools: body.allowedTools,
        allowedAgents: body.allowedAgents,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
      });

      if (!entry) {
        return { error: 'Credential not found' };
      }

      const { encryptedValue, encryptionIv, encryptionAuthTag, ...safe } = entry;

      return safe;
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        value: t.Optional(t.String()),
        description: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
        allowedTools: t.Optional(t.Array(t.String())),
        allowedAgents: t.Optional(t.Array(t.String())),
        expiresAt: t.Optional(t.String()),
      }),
      detail: { tags: ['vault'] },
    }
  )

  // Delete credential
  .delete(
    '/:id',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const vault = getVault();
      // Try user's own credentials first, then system credentials for admins
      let deleted = await vault.delete(user.id, params.id);
      if (!deleted && user.isAdmin) {
        deleted = await vault.delete('system', params.id);
      }

      if (!deleted) {
        return { error: 'Credential not found' };
      }

      return { success: true };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['vault'] },
    }
  )

  // Rotate credential
  .post(
    '/:id/rotate',
    async ({ user, params, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const vault = getVault();
      let rotated = await vault.rotate(user.id, params.id, body.value);
      if (!rotated && user.isAdmin) {
        rotated = await vault.rotate('system', params.id, body.value);
      }

      if (!rotated) {
        return { error: 'Credential not found' };
      }

      return { success: true };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        value: t.String({ minLength: 1 }),
      }),
      detail: { tags: ['vault'] },
    }
  );
