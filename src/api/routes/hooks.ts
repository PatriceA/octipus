import { Elysia, t } from 'elysia';
import { getHookManager } from '@/hooks/manager';
import { apiContext } from '@/api/context';

// Boundary schemas — these mirror the hook domain types (src/hooks/types.ts)
// so Elysia validates the request precisely and the handlers can pass the body
// straight through without `as any` coercion (DESIGN.md rules #1 and #8).
const triggerSchema = t.Union([
  t.Literal('message.received'),
  t.Literal('message.sent'),
  t.Literal('agent.completed'),
  t.Literal('agent.failed'),
  t.Literal('tool.called'),
  t.Literal('tool.failed'),
  t.Literal('session.started'),
  t.Literal('session.ended'),
  t.Literal('schedule'),
  t.Literal('webhook'),
]);

const conditionSchema = t.Object({
  field: t.String(),
  operator: t.Union([
    t.Literal('equals'),
    t.Literal('contains'),
    t.Literal('matches'),
    t.Literal('gt'),
    t.Literal('lt'),
    t.Literal('exists'),
  ]),
  value: t.Optional(t.Unknown()),
});

const actionSchema = t.Object({
  type: t.Union([
    t.Literal('http_request'),
    t.Literal('send_message'),
    t.Literal('run_tool'),
    t.Literal('spawn_agent'),
    t.Literal('log'),
  ]),
  config: t.Record(t.String(), t.Unknown()),
});

const configSchema = t.Record(t.String(), t.Unknown());

export const hookRoutes = new Elysia({ prefix: '/hooks' })
  .use(apiContext)
  .get('/', async ({ user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const mgr = getHookManager();
      return { hooks: mgr.list() };
    },
    { detail: { tags: ['hooks'] } }
  )
  .post('/', async ({ user, body, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const mgr = getHookManager();
      const hook = await mgr.create(
        user.id,
        body.name,
        body.trigger,
        body.config ?? {},
        body.conditions ?? [],
        body.actions ?? [],
      );
      return { hook };
    },
    {
      body: t.Object({
        name: t.String(),
        trigger: triggerSchema,
        config: t.Optional(configSchema),
        conditions: t.Optional(t.Array(conditionSchema)),
        actions: t.Optional(t.Array(actionSchema)),
      }),
      detail: { tags: ['hooks'] },
    }
  )
  .put('/:id', async ({ user, params, body, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const mgr = getHookManager();
      const updated = await mgr.update(user.id, params.id, body);
      return { updated };
    },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        trigger: t.Optional(triggerSchema),
        config: t.Optional(configSchema),
        conditions: t.Optional(t.Array(conditionSchema)),
        actions: t.Optional(t.Array(actionSchema)),
        enabled: t.Optional(t.Boolean()),
      }),
      detail: { tags: ['hooks'] },
    }
  )
  .delete('/:id', async ({ user, params, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const mgr = getHookManager();
      await mgr.delete(user.id, params.id);
      return { deleted: true };
    },
    { detail: { tags: ['hooks'] } }
  )
  .post('/:id/toggle', async ({ user, params, body, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const mgr = getHookManager();
      const toggled = await mgr.setEnabled(user.id, params.id, body.enabled);
      return { toggled };
    },
    {
      body: t.Object({ enabled: t.Boolean() }),
      detail: { tags: ['hooks'] },
    }
  )
  .post('/:id/test', async ({ user, params, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const mgr = getHookManager();
      const result = await mgr.test(user.id, params.id);
      return { result };
    },
    { detail: { tags: ['hooks'] } }
  )
  .get('/:id/executions', async ({ user, params, query, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const mgr = getHookManager();
      const executions = await mgr.getExecutions(user.id, params.id, query);
      return { executions };
    },
    { detail: { tags: ['hooks'] } }
  )
  .post('/preview', async ({ user, body, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const mgr = getHookManager();
      const preview = mgr.preview(body.trigger ?? undefined);
      return { preview };
    },
    {
      body: t.Object({
        trigger: t.Optional(triggerSchema),
      }),
      detail: { tags: ['hooks'] },
    }
  )
  .post('/validate', async ({ user, body, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const mgr = getHookManager();
      const result = mgr.validate(body);
      return { result };
    },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        trigger: t.Optional(triggerSchema),
        config: t.Optional(configSchema),
        conditions: t.Optional(t.Array(conditionSchema)),
        actions: t.Optional(t.Array(actionSchema)),
      }),
      detail: { tags: ['hooks'] },
    }
  );
