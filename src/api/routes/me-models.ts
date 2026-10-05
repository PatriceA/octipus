import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { isAuthenticated } from '@/security/principal';
import {
  createPersonalModel,
  createPersonalModelSchema,
  deletePersonalModel,
  listPersonalModels,
  PERSONAL_BINDABLE_TOPICS,
  PERSONAL_MODEL_PROVIDERS,
  PersonalModelError,
  updatePersonalModel,
  updatePersonalModelSchema,
} from '@/services/personal-models';

/**
 * The caller's own models (coworking spec §8.4). Mounted at `/api/me/models`.
 *
 * Owner-only, admins included: a personal row is managed by its owner and by
 * nobody else (the admin model routes refuse personal rows). Bodies are
 * validated against an allowlist (`createPersonalModelSchema`); anything else
 * is a 400. Another user's model answers 404, the same as a missing one.
 */
export const meModelRoutes = new Elysia({ prefix: '/me/models' })
  .use(apiContext)

  .get(
    '/',
    async ({ user, principal, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      return {
        models: await listPersonalModels(principal.userId),
        providers: PERSONAL_MODEL_PROVIDERS,
        topics: PERSONAL_BINDABLE_TOPICS,
      };
    },
    { detail: { tags: ['models'] } },
  )

  .post(
    '/',
    async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const parsed = createPersonalModelSchema.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return { error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') };
      }
      try {
        set.status = 201;
        return { model: await createPersonalModel(principal.userId, parsed.data) };
      } catch (err) {
        if (!(err instanceof PersonalModelError)) throw err;
        set.status = err.status;
        return { error: err.message };
      }
    },
    { body: t.Any(), detail: { tags: ['models'] } },
  )

  .patch(
    '/:slug',
    async ({ user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      const parsed = updatePersonalModelSchema.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return { error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') };
      }
      try {
        return { model: await updatePersonalModel(principal.userId, params.slug, parsed.data) };
      } catch (err) {
        if (!(err instanceof PersonalModelError)) throw err;
        set.status = err.status;
        return { error: err.message };
      }
    },
    { params: t.Object({ slug: t.String() }), body: t.Any(), detail: { tags: ['models'] } },
  )

  .delete(
    '/:slug',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Authentication required' };
      }
      try {
        await deletePersonalModel(principal.userId, params.slug);
        return { deleted: true };
      } catch (err) {
        if (!(err instanceof PersonalModelError)) throw err;
        set.status = err.status;
        return { error: err.message };
      }
    },
    { params: t.Object({ slug: t.String() }), detail: { tags: ['models'] } },
  );
