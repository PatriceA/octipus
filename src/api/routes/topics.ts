import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getModelRegistry } from '@/models/model-registry';
import { getTopicConfig, setTopicConfig } from '@/models/topic-config';
import { TOPICS } from '@/models/topics';
import { apiLogger } from '@/utils/logger';

/**
 * Topic-centric configuration (W10). The canonical topic list (src/models/topics)
 * drives this endpoint, so backend + UI share one source. Per topic it surfaces
 * the current primary/backup model binding (read from model_config.topicRoles)
 * plus the per-topic extras the model card can't hold (executorModel,
 * temperature, maxTokens — stored in topics_config).
 */
export const topicRoutes = new Elysia({ prefix: '/topics' })
  .use(apiContext)

  // List every canonical topic with its current binding + extras.
  .get(
    '/',
    async ({ user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const models = await getModelRegistry().getAllModelsIncludeDisabled();

      // Reverse-index topic → primary/backup model name from topicRoles.
      const primaryByTopic = new Map<string, string>();
      const backupByTopic = new Map<string, string>();
      for (const m of models) {
        const roles = (m.topicRoles ?? {}) as Record<string, 'primary' | 'backup'>;
        for (const [topic, role] of Object.entries(roles)) {
          if (role === 'primary') primaryByTopic.set(topic, m.name);
          else if (role === 'backup') backupByTopic.set(topic, m.name);
        }
      }

      const topics = TOPICS.map((tdef) => {
        const cfg = getTopicConfig(tdef.value);
        return {
          value: tdef.value,
          label: tdef.label,
          description: tdef.description,
          kind: tdef.kind,
          primaryModel: primaryByTopic.get(tdef.value) ?? null,
          backupModel: backupByTopic.get(tdef.value) ?? null,
          executorModel: cfg.executorModel,
          temperature: cfg.temperature,
          maxTokens: cfg.maxTokens,
        };
      });

      return { topics };
    },
    { detail: { tags: ['topics'] } },
  )

  // Set a topic's extras (executorModel / temperature / maxTokens). Admin-only.
  .patch(
    '/:topic/config',
    async ({ params, body, user, set }) => {
      if (!user?.isAdmin) {
        set.status = 403;
        return { error: 'Admin access required' };
      }
      if (!TOPICS.some((t) => t.value === params.topic)) {
        set.status = 404;
        return { error: `Unknown topic: ${params.topic}` };
      }
      // True PATCH semantics: only fields present in the body change; omitted
      // fields keep their current value (a present `null` clears the field).
      const current = getTopicConfig(params.topic);
      const resolved = await setTopicConfig(params.topic, {
        executorModel: body.executorModel !== undefined ? body.executorModel : current.executorModel,
        temperature: body.temperature !== undefined ? body.temperature : current.temperature,
        maxTokens: body.maxTokens !== undefined ? body.maxTokens : current.maxTokens,
      });
      apiLogger.info({ topic: params.topic, by: user.id }, 'Topic config updated');
      return { topic: params.topic, ...resolved };
    },
    {
      params: t.Object({ topic: t.String() }),
      body: t.Object({
        executorModel: t.Optional(t.Union([t.String(), t.Null()])),
        temperature: t.Optional(t.Union([t.Number(), t.Null()])),
        maxTokens: t.Optional(t.Union([t.Number(), t.Null()])),
      }),
      detail: { tags: ['topics'] },
    },
  )

  // Set a topic's primary/backup model binding. Admin-only. Writes through
  // model_config.topicRoles via updateModel (which invalidates the topic cache).
  .put(
    '/:topic/binding',
    async ({ params, body, user, set }) => {
      if (!user?.isAdmin) {
        set.status = 403;
        return { error: 'Admin access required' };
      }
      const topic = params.topic;
      if (!TOPICS.some((t) => t.value === topic)) {
        set.status = 404;
        return { error: `Unknown topic: ${topic}` };
      }

      const registry = getModelRegistry();
      const models = await registry.getAllModelsIncludeDisabled();
      const byName = new Map(models.map((m) => [m.name, m]));

      // Validate requested model names exist (null/undefined = clear the role).
      for (const name of [body.primaryModel, body.backupModel]) {
        if (name && !byName.has(name)) {
          set.status = 400;
          return { error: `Unknown model: ${name}` };
        }
      }
      // A model can't be both primary and backup for the same topic.
      if (body.primaryModel && body.backupModel && body.primaryModel === body.backupModel) {
        set.status = 400;
        return { error: 'primaryModel and backupModel must differ' };
      }

      // Compute each model's new role for this topic, then write only the rows
      // that actually change. Only the role(s) the request addresses are
      // mutated: omitting primaryModel leaves existing 'primary' holders alone,
      // and likewise for backup.
      const newRoleFor = (m: (typeof models)[number]): 'primary' | 'backup' | undefined => {
        let role: 'primary' | 'backup' | undefined = ((m.topicRoles ?? {}) as Record<string, 'primary' | 'backup'>)[topic];
        if (body.primaryModel !== undefined) {
          if (m.name === body.primaryModel) role = 'primary';
          else if (role === 'primary') role = undefined; // demoted: another model took primary (or it was cleared)
        }
        if (body.backupModel !== undefined) {
          if (m.name === body.backupModel) role = 'backup';
          else if (role === 'backup') role = undefined; // lost backup
        }
        return role;
      };

      for (const m of models) {
        const roles = { ...((m.topicRoles ?? {}) as Record<string, 'primary' | 'backup'>) };
        const current = roles[topic];
        const want = newRoleFor(m);
        if (want === current) continue;
        if (want === undefined) delete roles[topic];
        else roles[topic] = want;
        await registry.updateModel(m.name, { topicRoles: roles });
      }

      apiLogger.info({ topic, primary: body.primaryModel, backup: body.backupModel, by: user.id }, 'Topic binding updated');
      return { topic, primaryModel: body.primaryModel ?? null, backupModel: body.backupModel ?? null };
    },
    {
      params: t.Object({ topic: t.String() }),
      body: t.Object({
        primaryModel: t.Optional(t.Union([t.String(), t.Null()])),
        backupModel: t.Optional(t.Union([t.String(), t.Null()])),
      }),
      detail: { tags: ['topics'] },
    },
  );
