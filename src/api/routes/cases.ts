import { isCaseEntityOn } from '@/core/modules/registry';
import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import { addFollowUp, CaseLinkError, caseLinks, linkToCase, resolveEntity } from '@/core/cases/links';
import { CASE_ENTITY_TYPES, CASE_STATUSES, CONTACT_KINDS, normalizeLabel, normalizeTags } from '@/core/cases/status';
import { parseTaskDate } from '@/core/tasks/timezone';
import { contentRepos } from '@/db/repositories/content';
import type { ContactAddress } from '@/db/schema/contacts';
import { isAuthenticated } from '@/security/principal';
import { SpaceError } from '@/security/space-access';

const STATUS = t.Union(CASE_STATUSES.map((s) => t.Literal(s)));
const ENTITY_TYPE = t.Union(CASE_ENTITY_TYPES.map((s) => t.Literal(s)));
const CONTACT_KIND = t.Union(CONTACT_KINDS.map((s) => t.Literal(s)));
const ADDRESS = t.Object({
  street: t.Optional(t.String({ maxLength: 200 })),
  postalCode: t.Optional(t.String({ maxLength: 20 })),
  city: t.Optional(t.String({ maxLength: 100 })),
  country: t.Optional(t.String({ maxLength: 100 })),
});
const ATTRIBUTES = t.Record(t.String({ maxLength: 100 }), t.String({ maxLength: 2000 }));

/** A write refused: a role refusal keeps its status through the error handler; anything else is a 400. */
function refused(err: unknown, set: { status?: number | string }): { error: string } {
  if (err instanceof SpaceError) throw err;
  set.status = 400;
  return { error: err instanceof Error ? err.message : String(err) };
}

/**
 * A required text field, trimmed: the schema's `minLength` sees the untrimmed
 * value, so whitespace alone would otherwise be stored as an empty title.
 */
function required(value: string, field: string): string {
  const v = value.trim();
  if (!v) throw new Error(`${field} cannot be empty`);
  return v;
}

/** An optional text field on a patch: absent stays absent, present must not be blank. */
function requiredIfGiven(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : required(value, field);
}

/** An address with its empty fields dropped; null when nothing is left. */
function normalizeAddress(value: ContactAddress | null | undefined): ContactAddress | null {
  if (!value) return null;
  const out: ContactAddress = {};
  for (const key of ['street', 'postalCode', 'city', 'country'] as const) {
    const v = value[key]?.trim();
    if (v) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

const NOT_AUTHENTICATED = { error: 'Not authenticated' };

/**
 * Cases ("Vorgänge") and what they link to (docs/CASES.md). Every read and
 * write goes through `contentRepos(principal)`: personally the caller's own
 * cases, in a space the space's (members read, editors write). An id the
 * scope does not reach is a 404, never a 403.
 */
export const caseRoutes = new Elysia({ prefix: '/cases' })
  .use(apiContext)

  .get(
    '/',
    async ({ principal, query, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      const limit = query?.limit ? Number.parseInt(query.limit, 10) || 200 : 200;
      return contentRepos(principal).cases.list({
        status: query?.status,
        statuses: query?.status ? undefined : query?.active === 'true' ? ['open', 'waiting'] : undefined,
        kind: query?.kind,
        assigneeUserId: query?.assignee,
        q: query?.q,
        limit,
      });
    },
    {
      query: t.Object({
        status: t.Optional(STATUS),
        /** `true`: open and waiting cases only. */
        active: t.Optional(t.String()),
        kind: t.Optional(t.String({ maxLength: 100 })),
        assignee: t.Optional(t.String()),
        q: t.Optional(t.String({ maxLength: 200 })),
        limit: t.Optional(t.String()),
      }),
      detail: { tags: ['cases'] },
    },
  )

  // The cases an entity is linked to (a contact's, a document's, a task's).
  .get(
    '/linked',
    async ({ principal, query, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      // An entity the caller cannot see has no cases to show (its id could
      // otherwise be probed for which cases it belongs to).
      const repos = contentRepos(principal);
      if (!isCaseEntityOn(query.entityType)) return [];
      if (!(await resolveEntity(repos, query.entityType, query.entityId))) return [];
      return repos.cases.casesLinkedTo(query.entityType, query.entityId);
    },
    {
      query: t.Object({ entityType: ENTITY_TYPE, entityId: t.String() }),
      detail: { tags: ['cases'] },
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
        return await contentRepos(principal).cases.create({
          title: required(body.title, 'title'),
          kind: normalizeLabel(body.kind),
          status: body.status ?? 'open',
          summary: body.summary ?? null,
          assigneeUserId: body.assigneeUserId ?? null,
          source: 'user',
          protectionLevel: body.protectionLevel ?? null,
        });
      } catch (err) {
        return refused(err, set);
      }
    },
    {
      body: t.Object({
        title: t.String({ minLength: 1, maxLength: 500 }),
        kind: t.Optional(t.String({ maxLength: 100 })),
        status: t.Optional(STATUS),
        summary: t.Optional(t.String({ maxLength: 20_000 })),
        assigneeUserId: t.Optional(t.String()),
        /** 1-4; absent: unclear (docs/PROTECTION-LEVELS.md). */
        protectionLevel: t.Optional(t.Union([t.Integer({ minimum: 1, maximum: 4 }), t.Null()])),
      }),
      detail: { tags: ['cases'] },
    },
  )

  // One case with its resolved links.
  .get(
    '/:id',
    async ({ principal, params, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      const repos = contentRepos(principal);
      const found = await repos.cases.findById(params.id);
      const links = found ? await caseLinks(repos, found) : null;
      if (!found || !links) {
        set.status = 404;
        return { error: 'Case not found' };
      }
      return { ...found, links };
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['cases'] } },
  )

  .patch(
    '/:id',
    async ({ principal, params, body, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      try {
        const updated = await contentRepos(principal).cases.update(params.id, {
          title: requiredIfGiven(body.title, 'title'),
          kind: body.kind !== undefined ? normalizeLabel(body.kind) : undefined,
          status: body.status,
          summary: body.summary,
          assigneeUserId: body.assigneeUserId,
        });
        if (!updated) {
          set.status = 404;
          return { error: 'Case not found' };
        }
        return updated;
      } catch (err) {
        return refused(err, set);
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        title: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
        kind: t.Optional(t.Union([t.String({ maxLength: 100 }), t.Null()])),
        status: t.Optional(STATUS),
        summary: t.Optional(t.Union([t.String({ maxLength: 20_000 }), t.Null()])),
        assigneeUserId: t.Optional(t.Union([t.String(), t.Null()])),
      }),
      detail: { tags: ['cases'] },
    },
  )

  .delete(
    '/:id',
    async ({ principal, params, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      const deleted = await contentRepos(principal).cases.delete(params.id);
      if (!deleted) {
        set.status = 404;
        return { error: 'Case not found' };
      }
      return { deleted: true };
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['cases'] } },
  )

  // Link a contact, document, task, note or artifact of the same scope.
  .post(
    '/:id/links',
    async ({ principal, params, body, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      try {
        const link = await linkToCase(contentRepos(principal), params.id, body);
        if (!link) {
          set.status = 404;
          return { error: 'Case not found' };
        }
        return link;
      } catch (err) {
        if (err instanceof CaseLinkError) {
          set.status = 400;
          return { error: err.message };
        }
        return refused(err, set);
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        entityType: ENTITY_TYPE,
        entityId: t.String(),
        role: t.Optional(t.String({ maxLength: 100 })),
      }),
      detail: { tags: ['cases'] },
    },
  )

  .delete(
    '/:id/links/:linkId',
    async ({ principal, params, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      const removed = await contentRepos(principal).cases.removeLink(params.id, params.linkId);
      if (!removed) {
        set.status = 404;
        return { error: 'Link not found' };
      }
      return { deleted: true };
    },
    { params: t.Object({ id: t.String(), linkId: t.String() }), detail: { tags: ['cases'] } },
  )

  // A follow-up ("Wiedervorlage"): a task with a reminder date, linked to the case.
  .post(
    '/:id/follow-ups',
    async ({ principal, params, body, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      try {
        const result = await addFollowUp(contentRepos(principal), params.id, {
          title: required(body.title, 'title'),
          remindAt: await parseTaskDate(body.remindAt, 'remindAt', principal.userId, body.tz),
          dueAt: body.dueAt ? await parseTaskDate(body.dueAt, 'dueAt', principal.userId, body.tz) : null,
          notes: body.notes ?? null,
          assigneeUserId: body.assigneeUserId,
        });
        if (!result) {
          set.status = 404;
          return { error: 'Case not found' };
        }
        return result;
      } catch (err) {
        return refused(err, set);
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        title: t.String({ minLength: 1, maxLength: 500 }),
        remindAt: t.String(),
        dueAt: t.Optional(t.String()),
        notes: t.Optional(t.String({ maxLength: 10_000 })),
        assigneeUserId: t.Optional(t.Union([t.String(), t.Null()])),
        /** Browser zone; decides which day a bare `YYYY-MM-DD` falls on. */
        tz: t.Optional(t.String({ maxLength: 64 })),
      }),
      detail: { tags: ['cases'] },
    },
  );

/**
 * Contacts ("Personen", docs/CASES.md): the people and organisations of a
 * scope, scoped like cases.
 */
export const contactRoutes = new Elysia({ prefix: '/contacts' })
  .use(apiContext)

  .get(
    '/',
    async ({ principal, query, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      const limit = query?.limit ? Number.parseInt(query.limit, 10) || 200 : 200;
      return contentRepos(principal).contacts.list({
        kind: query?.kind,
        tag: query?.tag,
        q: query?.q,
        organizationId: query?.organizationId,
        limit,
      });
    },
    {
      query: t.Object({
        kind: t.Optional(CONTACT_KIND),
        tag: t.Optional(t.String({ maxLength: 50 })),
        q: t.Optional(t.String({ maxLength: 200 })),
        organizationId: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
      detail: { tags: ['contacts'] },
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
        return await contentRepos(principal).contacts.create({
          kind: body.kind ?? 'person',
          name: required(body.name, 'name'),
          email: body.email?.trim() || null,
          phone: body.phone?.trim() || null,
          address: normalizeAddress(body.address),
          organizationId: body.organizationId || null,
          tags: normalizeTags(body.tags),
          notes: body.notes ?? null,
          attributes: body.attributes ?? {},
        });
      } catch (err) {
        return refused(err, set);
      }
    },
    {
      body: t.Object({
        kind: t.Optional(CONTACT_KIND),
        name: t.String({ minLength: 1, maxLength: 300 }),
        email: t.Optional(t.String({ maxLength: 320 })),
        phone: t.Optional(t.String({ maxLength: 50 })),
        address: t.Optional(ADDRESS),
        organizationId: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String({ maxLength: 50 }), { maxItems: 20 })),
        notes: t.Optional(t.String({ maxLength: 20_000 })),
        attributes: t.Optional(ATTRIBUTES),
      }),
      detail: { tags: ['contacts'] },
    },
  )

  // One contact with the cases it is linked to.
  .get(
    '/:id',
    async ({ principal, params, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      const repos = contentRepos(principal);
      const contact = await repos.contacts.findById(params.id);
      if (!contact) {
        set.status = 404;
        return { error: 'Contact not found' };
      }
      const linked = await repos.cases.casesLinkedTo('contact', contact.id);
      return { ...contact, cases: linked.map((l) => ({ ...l.case, role: l.role })) };
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['contacts'] } },
  )

  .patch(
    '/:id',
    async ({ principal, params, body, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      try {
        const updated = await contentRepos(principal).contacts.update(params.id, {
          kind: body.kind,
          name: requiredIfGiven(body.name, 'name'),
          email: body.email !== undefined ? body.email?.trim() || null : undefined,
          phone: body.phone !== undefined ? body.phone?.trim() || null : undefined,
          address: body.address !== undefined ? normalizeAddress(body.address) : undefined,
          organizationId: body.organizationId !== undefined ? body.organizationId || null : undefined,
          tags: body.tags !== undefined ? normalizeTags(body.tags) : undefined,
          notes: body.notes,
          attributes: body.attributes,
        });
        if (!updated) {
          set.status = 404;
          return { error: 'Contact not found' };
        }
        return updated;
      } catch (err) {
        return refused(err, set);
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        kind: t.Optional(CONTACT_KIND),
        name: t.Optional(t.String({ minLength: 1, maxLength: 300 })),
        email: t.Optional(t.Union([t.String({ maxLength: 320 }), t.Null()])),
        phone: t.Optional(t.Union([t.String({ maxLength: 50 }), t.Null()])),
        address: t.Optional(t.Union([ADDRESS, t.Null()])),
        organizationId: t.Optional(t.Union([t.String(), t.Null()])),
        tags: t.Optional(t.Array(t.String({ maxLength: 50 }), { maxItems: 20 })),
        notes: t.Optional(t.Union([t.String({ maxLength: 20_000 }), t.Null()])),
        attributes: t.Optional(ATTRIBUTES),
      }),
      detail: { tags: ['contacts'] },
    },
  )

  .delete(
    '/:id',
    async ({ principal, params, set }) => {
      if (!isAuthenticated(principal)) {
        set.status = 401;
        return NOT_AUTHENTICATED;
      }
      const deleted = await contentRepos(principal).contacts.delete(params.id);
      if (!deleted) {
        set.status = 404;
        return { error: 'Contact not found' };
      }
      return { deleted: true };
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['contacts'] } },
  );
