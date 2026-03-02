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
      // Admins also see system-level credentials (OAuth client IDs, etc.)
      const systemEntries = user.isAdmin ? await vault.list('system') : [];
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
      const ownerId = body.systemLevel && user.isAdmin ? 'system' : user.id;
      const entry = await vault.store(ownerId, body.name, body.value, {
        credentialType: body.credentialType,
        description: body.description,
        tags: body.tags,
        allowedSkills: body.allowedSkills,
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
        allowedSkills: t.Optional(t.Array(t.String())),
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
        allowedSkills: body.allowedSkills,
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
        allowedSkills: t.Optional(t.Array(t.String())),
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
      const deleted = await vault.delete(user.id, params.id);

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
      const rotated = await vault.rotate(user.id, params.id, body.value);

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
