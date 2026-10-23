import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import { normalizeLabel } from '@/core/cases/status';
import { RecordValidationError } from '@/core/records/fields';
import { publicForm, submitForm } from '@/core/records/forms';
import { contentRepos } from '@/db/repositories/content';
import { uniqueViolation } from '@/db/unique-violation';
import { isAuthenticated } from '@/security/principal';
import { SpaceError } from '@/security/space-access';
import { apiLogger } from '@/utils/logger';

const NOT_AUTHENTICATED = { error: 'Not authenticated' };

/**
 * A write refused: a role refusal keeps its status; invalid input is a 400
 * listing every problem; a write that lost a race to another (the same key
 * created twice, a record added while its type was deleted) is a 409.
 * Anything else is logged and a 500 that does not echo database text.
 */
function refused(err: unknown, set: { status?: number | string }): { error: string; problems?: string[] } {
  if (err instanceof SpaceError) throw err;
  if (err instanceof RecordValidationError) {
    set.status = 400;
    return { error: err.message, problems: err.problems };
  }
  if (uniqueViolation(err) !== null || foreignKeyViolation(err)) {
    set.status = 409;
    return { error: 'This changed at the same time elsewhere; reload and try again' };
  }
  apiLogger.error({ err }, 'records: write failed');
  set.status = 500;
  return { error: 'The change could not be saved' };
}

/** A Postgres foreign-key violation (23503), possibly wrapped by Drizzle. */
function foreignKeyViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === '23503') return true;
  }
  return false;
}

const FIELDS = t.Array(t.Unknown(), { maxItems: 50 });
const DATA = t.Record(t.String({ maxLength: 50 }), t.Unknown());

/**
 * Record types, records and form links (docs/RECORDS.md). Scoped through
 * `contentRepos(principal)` like cases: personally the caller's own, in a
 * space the space's (members read, editors write). Field definitions and
 * record data are validated in core/records/fields.ts; a refusal lists every
 * problem in `problems`.
 */
export const recordTypeRoutes = new Elysia({ prefix: '/record-types' })
  .use(apiContext)

  .get(
    '/',
    async ({ principal, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      return contentRepos(principal).recordTypes.list();
    },
    { detail: { tags: ['records'] } },
  )

  .post(
    '/',
    async ({ principal, body, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      try {
        return await contentRepos(principal).recordTypes.create(body);
      } catch (err) {
        return refused(err, set);
      }
    },
    {
      body: t.Object({
        key: t.String({ maxLength: 50 }),
        name: t.String({ minLength: 1, maxLength: 200 }),
        description: t.Optional(t.String({ maxLength: 2000 })),
        fields: FIELDS,
        titleField: t.Optional(t.String({ maxLength: 50 })),
        defaultProtectionLevel: t.Optional(t.Union([t.Integer({ minimum: 1, maximum: 4 }), t.Null()])),
      }),
      detail: { tags: ['records'] },
    },
  )

  .get(
    '/:id',
    async ({ principal, params, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      const type = await contentRepos(principal).recordTypes.resolve(params.id);
      if (!type) {
        set.status = 404;
        return { error: 'Record type not found' };
      }
      return type;
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['records'] } },
  )

  .patch(
    '/:id',
    async ({ principal, params, body, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      try {
        const updated = await contentRepos(principal).recordTypes.update(params.id, body);
        if (!updated) {
          set.status = 404;
          return { error: 'Record type not found' };
        }
        return updated;
      } catch (err) {
        return refused(err, set);
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        key: t.Optional(t.String({ maxLength: 50 })),
        name: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
        description: t.Optional(t.Union([t.String({ maxLength: 2000 }), t.Null()])),
        fields: t.Optional(FIELDS),
        titleField: t.Optional(t.Union([t.String({ maxLength: 50 }), t.Null()])),
        defaultProtectionLevel: t.Optional(t.Union([t.Integer({ minimum: 1, maximum: 4 }), t.Null()])),
      }),
      detail: { tags: ['records'] },
    },
  )

  .delete(
    '/:id',
    async ({ principal, params, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      try {
        const deleted = await contentRepos(principal).recordTypes.delete(params.id);
        if (!deleted) {
          set.status = 404;
          return { error: 'Record type not found' };
        }
        return { deleted: true };
      } catch (err) {
        return refused(err, set);
      }
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['records'] } },
  )

  // Form links of a type. The raw token is in the create response only.
  .get(
    '/:id/form-links',
    async ({ principal, params, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      const links = await contentRepos(principal).formLinks.list(params.id);
      if (!links) {
        set.status = 404;
        return { error: 'Record type not found' };
      }
      return links;
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['records'] } },
  )

  .post(
    '/:id/form-links',
    async ({ principal, params, body, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      try {
        const title = body.title.trim();
        if (!title) throw new RecordValidationError(['title cannot be empty']);
        let expiresAt: Date | null = null;
        if (body.expiresAt) {
          expiresAt = new Date(body.expiresAt);
          if (Number.isNaN(expiresAt.getTime())) throw new RecordValidationError([`Invalid expiresAt "${body.expiresAt}"`]);
        }
        const minted = await contentRepos(principal).formLinks.create(params.id, {
          title,
          intro: body.intro ?? null,
          caseKind: normalizeLabel(body.caseKind),
          expiresAt,
          maxSubmissions: body.maxSubmissions ?? null,
        });
        if (!minted) {
          set.status = 404;
          return { error: 'Record type not found' };
        }
        return { ...minted.link, token: minted.token, path: `/forms/${minted.token}` };
      } catch (err) {
        return refused(err, set);
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        title: t.String({ minLength: 1, maxLength: 200 }),
        intro: t.Optional(t.String({ maxLength: 5000 })),
        caseKind: t.Optional(t.String({ maxLength: 100 })),
        expiresAt: t.Optional(t.String()),
        maxSubmissions: t.Optional(t.Integer({ minimum: 1, maximum: 100_000 })),
      }),
      detail: { tags: ['records'] },
    },
  )

  .delete(
    '/:id/form-links/:linkId',
    async ({ principal, params, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      const revoked = await contentRepos(principal).formLinks.revoke(params.id, params.linkId);
      if (!revoked) {
        set.status = 404;
        return { error: 'Form link not found' };
      }
      return { revoked: true };
    },
    { params: t.Object({ id: t.String(), linkId: t.String() }), detail: { tags: ['records'] } },
  );

export const recordRoutes = new Elysia({ prefix: '/records' })
  .use(apiContext)

  .get(
    '/',
    async ({ principal, query, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      const repos = contentRepos(principal);
      let typeId: string | undefined;
      if (query?.type) {
        const type = await repos.recordTypes.resolve(query.type);
        if (!type) return [];
        typeId = type.id;
      }
      const limit = query?.limit ? Number.parseInt(query.limit, 10) || 200 : 200;
      return repos.records.list({ typeId, q: query?.q, limit });
    },
    {
      query: t.Object({
        /** A type id or key. */
        type: t.Optional(t.String({ maxLength: 100 })),
        q: t.Optional(t.String({ maxLength: 200 })),
        limit: t.Optional(t.String()),
      }),
      detail: { tags: ['records'] },
    },
  )

  .post(
    '/',
    async ({ principal, body, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      try {
        return await contentRepos(principal).records.create(body.type, { data: body.data, source: 'user', protectionLevel: body.protectionLevel });
      } catch (err) {
        return refused(err, set);
      }
    },
    {
      body: t.Object({
        /** A type id or key. */
        type: t.String({ minLength: 1, maxLength: 100 }),
        data: DATA,
        /** 1-4; absent: the type's default (docs/PROTECTION-LEVELS.md). */
        protectionLevel: t.Optional(t.Union([t.Integer({ minimum: 1, maximum: 4 }), t.Null()])),
      }),
      detail: { tags: ['records'] },
    },
  )

  .get(
    '/:id',
    async ({ principal, params, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      const repos = contentRepos(principal);
      const record = await repos.records.findById(params.id);
      if (!record) {
        set.status = 404;
        return { error: 'Record not found' };
      }
      const cases = await repos.cases.casesLinkedTo('record', record.id);
      return { ...record, cases: cases.map((l) => ({ ...l.case, role: l.role })) };
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['records'] } },
  )

  .patch(
    '/:id',
    async ({ principal, params, body, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      try {
        const updated = await contentRepos(principal).records.update(params.id, body.data);
        if (!updated) {
          set.status = 404;
          return { error: 'Record not found' };
        }
        return updated;
      } catch (err) {
        return refused(err, set);
      }
    },
    { params: t.Object({ id: t.String() }), body: t.Object({ data: DATA }), detail: { tags: ['records'] } },
  )

  .delete(
    '/:id',
    async ({ principal, params, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      const deleted = await contentRepos(principal).records.delete(params.id);
      if (!deleted) {
        set.status = 404;
        return { error: 'Record not found' };
      }
      return { deleted: true };
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['records'] } },
  );

/**
 * Public forms: no sign-in, the token is the credential (auth-guard lists
 * these two routes; the rate limiter counts them as credential attempts, so
 * guessing tokens and flooding a form are both held to the tight per-IP
 * window). A dead or unknown token is a 404 either way, never told apart.
 */
export const publicFormRoutes = new Elysia({ prefix: '/forms' })
  .get(
    '/:token',
    async ({ params, set }) => {
      const form = await publicForm(params.token);
      if (!form) {
        set.status = 404;
        return { error: 'This form is not available' };
      }
      return form;
    },
    { params: t.Object({ token: t.String({ maxLength: 100 }) }), detail: { tags: ['records'] } },
  )

  .post(
    '/:token',
    async ({ params, body, set }) => {
      try {
        const result = await submitForm(params.token, body.data);
        if (!result.ok) {
          set.status = 404;
          return { error: 'This form is not available' };
        }
        return { submitted: true };
      } catch (err) {
        if (err instanceof RecordValidationError) {
          set.status = 400;
          return { error: err.message, problems: err.problems };
        }
        apiLogger.error({ err }, 'forms: submission failed');
        set.status = 500;
        return { error: 'The form could not be saved. Try again later.' };
      }
    },
    {
      params: t.Object({ token: t.String({ maxLength: 100 }) }),
      body: t.Object({ data: DATA }),
      detail: { tags: ['records'] },
    },
  );
