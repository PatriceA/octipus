import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getHookManager } from '@/hooks/manager';

export const hookRoutes = new Elysia({ prefix: '/hooks' })
  .use(apiContext)
  // List user's hooks
  .get(
    '/',
    async ({ user }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const hookManager = getHookManager();
      const hooks = await hookManager.getUserHooks(user.id);

      return { hooks };
    },
    { detail: { tags: ['hooks'] } }
  )

  // Get hook by ID
  .get(
    '/:id',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const hookManager = getHookManager();
      const hook = await hookManager.getHook(params.id);

      if (!hook) {
        return { error: 'Hook not found' };
      }

      if (!user.isAdmin && hook.userId !== user.id) {
        return { error: 'Not authorized' };
      }

      return hook;
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: { tags: ['hooks'] },
    }
  )

  // Create hook
  .post(
    '/',
    async ({ user, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const hookManager = getHookManager();

      const hook = await hookManager.createHook({
        userId: user.id,
        name: body.name,
        description: body.description,
        trigger: body.trigger as any,
        triggerConfig: body.triggerConfig,
        action: body.action as any,
        actionConfig: body.actionConfig,
        conditions: body.conditions,
        isEnabled: body.isEnabled ?? true,
        priority: body.priority ?? 0,
        maxExecutions: body.maxExecutions,
        cooldownMs: body.cooldownMs,
      });

      return hook;
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.String()),
        trigger: t.String(),
        triggerConfig: t.Any(),
        action: t.String(),
        actionConfig: t.Any(),
        conditions: t.Optional(t.Array(t.Any())),
        isEnabled: t.Optional(t.Boolean()),
        priority: t.Optional(t.Number()),
        maxExecutions: t.Optional(t.Number()),
        cooldownMs: t.Optional(t.Number()),
      }),
      detail: { tags: ['hooks'] },
    }
  )

  // Update hook
  .patch(
    '/:id',
    async ({ user, params, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const hookManager = getHookManager();
      const existing = await hookManager.getHook(params.id);

      if (!existing) {
        return { error: 'Hook not found' };
      }

      if (!user.isAdmin && existing.userId !== user.id) {
        return { error: 'Not authorized' };
      }

      const hook = await hookManager.updateHook(params.id, body as any);

      return hook;
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      body: t.Object({
        name: t.Optional(t.String()),
        description: t.Optional(t.String()),
        triggerConfig: t.Optional(t.Any()),
        actionConfig: t.Optional(t.Any()),
        conditions: t.Optional(t.Array(t.Any())),
        isEnabled: t.Optional(t.Boolean()),
        priority: t.Optional(t.Number()),
        maxExecutions: t.Optional(t.Number()),
        cooldownMs: t.Optional(t.Number()),
      }),
      detail: { tags: ['hooks'] },
    }
  )

  // Delete hook
  .delete(
    '/:id',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const hookManager = getHookManager();
      const existing = await hookManager.getHook(params.id);

      if (!existing) {
        return { error: 'Hook not found' };
      }

      if (!user.isAdmin && existing.userId !== user.id) {
        return { error: 'Not authorized' };
      }

      const deleted = await hookManager.deleteHook(params.id);

      return { deleted };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: { tags: ['hooks'] },
    }
  )

  // Enable/disable hook
  .post(
    '/:id/toggle',
    async ({ user, params, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const hookManager = getHookManager();
      const existing = await hookManager.getHook(params.id);

      if (!existing) {
        return { error: 'Hook not found' };
      }

      if (!user.isAdmin && existing.userId !== user.id) {
        return { error: 'Not authorized' };
      }

      const success = await hookManager.setEnabled(params.id, body.enabled);

      return { success, enabled: body.enabled };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      body: t.Object({
        enabled: t.Boolean(),
      }),
      detail: { tags: ['hooks'] },
    }
  )

  // Test hook (trigger manually)
  .post(
    '/:id/test',
    async ({ user, params, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const hookManager = getHookManager();
      const hook = await hookManager.getHook(params.id);

      if (!hook) {
        return { error: 'Hook not found' };
      }

      if (!user.isAdmin && hook.userId !== user.id) {
        return { error: 'Not authorized' };
      }

      // Trigger the hook with test context
      const results = await hookManager.trigger(
        { type: hook.trigger, data: body.data || {}, timestamp: new Date() },
        body.context || {}
      );

      return { results };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      body: t.Object({
        data: t.Optional(t.Any()),
        context: t.Optional(t.Any()),
      }),
      detail: { tags: ['hooks'] },
    }
  );
