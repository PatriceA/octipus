import { and, eq, inArray } from 'drizzle-orm';
import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { adminDenied } from '@/api/admin-guard';
import { getDb } from '@/db/postgres';
import { skillRepository } from '@/db/repositories/skill-repository';
import { type SkillView, skills } from '@/db/schema/skills';
import { hiddenSkillRepository } from '@/db/repositories/hidden-skill-repository';
import { skillSelections } from '@/db/schema/skill-selections';
import { isExternalSkillId } from '@/skills/external-loader';
import { getSkillRegistry } from '@/skills/registry';
import { recordSkillUsage } from '@/skills/usage-tracker';
import { isInPersonWrite, updateSkill, SkillUpdateError } from '@/skills/update';
import { getSkillModes } from '@/skills/selection';
import { skillSelectionRepository } from '@/db/repositories/skill-selection-repository';
import { scopedRepos } from '@/db/repositories/scoped';
import { isAdmin, isAuthenticated, type Principal, requireScope } from '@/security/principal';
import { API_SCOPES } from '@/security/scopes';
import { skillsToMarkdown, skillToMarkdown, toPortableSkill } from '@/skills/markdown';
import { buildBundle, MAX_BUNDLE_BYTES, MAX_BUNDLE_SKILLS, SkillBundleError, toBundleSkill, UNSIGNED_EXPORT_NOTE } from '@/skills/exchange';
import { type ImportActor, installImport, previewImport } from '@/skills/exchange-import';
import { listSkillRegistries } from '@/skills/registries';
import type { SkillBundleExport } from '@/shared/skill-exchange';
import { canActInSession } from '@/core/rooms/access';

/** The one source an import reads: a bundle's JSON text, a SKILL.md, an https URL (admins), or a skill registry listing. */
const IMPORT_SOURCE_FIELDS = {
  bundle: t.Optional(t.String({ minLength: 1, maxLength: MAX_BUNDLE_BYTES })),
  skillMd: t.Optional(t.String({ minLength: 1, maxLength: MAX_BUNDLE_BYTES })),
  url: t.Optional(t.String({ minLength: 9, maxLength: 2000, pattern: '^https://' })),
  registry: t.Optional(t.Object({
    registry: t.String({ minLength: 1, maxLength: 100 }),
    name: t.String({ minLength: 1, maxLength: 100 }),
    version: t.String({ minLength: 1, maxLength: 100 }),
  })),
};
const IMPORT_SOURCE_BODY = t.Object(IMPORT_SOURCE_FIELDS);

function importActor(userId: string, principal: Principal, session: { userAgent?: string } | null): ImportActor {
  return { userId, admin: isAdmin(principal), inPerson: isInPersonWrite(principal, session), actorUserId: principal.actorUserId ?? null };
}

export const skillRoutes = new Elysia({ prefix: '/skills' })
  .use(apiContext)

  // Rescans the install's mounted skill folders: install state, admin only.
  .post('/reload-mounted', ({ user, principal, set }) => {
    const denied = adminDenied({ set, user, principal });
    if (denied) return denied;
    try {
      getSkillRegistry().reloadExternal();
      return { reloaded: true };
    } catch {
      set.status = 500;
      return { error: 'Could not reload mounted skills. Previously loaded skills remain available.' };
    }
  }, { detail: { tags: ['skills'] } })

  .get('/usage', async ({ user, principal, query, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    let ownerId: string = user.id;
    if (query.sessionId) {
      const session = await scopedRepos(principal).sessions.findById(query.sessionId);
      if (!session) { set.status = 404; return { error: 'Session not found' }; }
      ownerId = session.userId;
    }
    const [modes, available] = await Promise.all([
      getSkillModes(ownerId, query.sessionId),
      getSkillRegistry().getAll(ownerId),
    ]);
    const skills = available.map(skill => ({ id: skill.id, name: skill.name, description: skill.description,
      mode: modes.get(skill.id) ?? 'automatic', available: true }));
    // Deleted or unmounted pins remain removable rather than silently disappearing.
    const visible = new Set(available.map(skill => skill.id));
    for (const [id, mode] of modes) if (!visible.has(id)) skills.push({ id, name: id,
      description: 'This selected skill is unavailable. Choose Automatic to continue without it.', mode, available: false });
    return { skills };
  }, {
    query: t.Object({ sessionId: t.Optional(t.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' })) }),
    detail: { tags: ['skills'] },
  })

  .patch('/usage', async ({ user, principal, body, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    const ownerId = user.id;
    if (body.sessionId) {
      const session = await scopedRepos(principal).sessions.findById(body.sessionId);
      if (!session) { set.status = 404; return { error: 'Session not found' }; }
      // Admins may read another user's chat, but never change that user's skill defaults.
      if (!(await canActInSession(session, ownerId, 'settings'))) { set.status = 403; return { error: 'Only the chat owner can change its skills' }; }
    }
    if (body.mode === 'session' && !body.sessionId) { set.status = 400; return { error: 'A session is required' }; }
    const registry = getSkillRegistry();
    const skillId = registry.canonicalId(body.skillId);
    if (body.mode !== 'automatic') {
      const available = await registry.getAll(ownerId);
      if (!available.some(skill => skill.id === skillId)) { set.status = 404; return { error: 'Skill not found' }; }
    }
    await skillSelectionRepository.set(ownerId, skillId, body.mode, body.sessionId, registry.sourceIds(skillId));
    return { saved: true };
  }, {
    body: t.Object({ skillId: t.String({ minLength: 1, maxLength: 512 }),
      mode: t.Union([t.Literal('automatic'), t.Literal('always'), t.Literal('session')]),
      sessionId: t.Optional(t.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' })) }),
    detail: { tags: ['skills'] },
  })

  .get(
    '/',
    async ({ user }) => {
      const ownerId = user?.id;
      const found = await getSkillRegistry().getAll(ownerId);
      return { skills: found.filter(skill => user || skill.isSystem).map(skill => ({ ...skill,
        mounted: isExternalSkillId(skill.id),
        canEdit: !!user && !isExternalSkillId(skill.id) && (user.isAdmin || (!skill.isSystem && skill.userId === ownerId)),
        canDelete: !!user && (skill.isSystem || user.isAdmin || skill.userId === ownerId || !!skill.orgId),
        removeOnly: skill.isSystem || isExternalSkillId(skill.id) || (!!skill.orgId && skill.userId !== ownerId),
      })) };
    },
    { detail: { tags: ['skills'] } }
  )

  // ---- Plain exports (must be before /:id): JSON or markdown, unsigned. Both
  // import through /exchange/preview and /exchange/install below
  // (docs/SKILL-EXCHANGE.md#older-exports). ----

  .get(
    '/export',
    async ({ user, principal, query }) => {
      const db = getDb();
      const format = query.format ?? 'json';

      let rows: SkillView[];
      if (query.ids) {
        const idList = query.ids.split(',').map((s: string) => s.trim()).filter(Boolean);
        // Same rule as GET /:id/export: an admin exports any row, a user only
        // what they can see (system, own, their orgs'), anonymous only system.
        if (user && isAdmin(principal)) rows = await skillRepository.findByIds(idList);
        else if (user) rows = await skillRepository.findVisibleByIds(user.id, idList);
        else if (idList.length === 0) rows = [];
        else rows = await db.select().from(skills).where(and(inArray(skills.id, idList), eq(skills.isSystem, true)));
      } else {
        // Export all custom (non-system) skills visible to the user
        if (user) {
          rows = await db.select().from(skills).where(
            user.id === 'system'
              ? eq(skills.isSystem, false)
              : eq(skills.userId, user.id)
          );
        } else {
          // Unauthenticated: export system skills only
          rows = await db.select().from(skills).where(eq(skills.isSystem, true));
        }
      }

      if (format === 'markdown') {
        return new Response(skillsToMarkdown(rows), {
          headers: {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Content-Disposition': 'attachment; filename="skills-export.md"',
          },
        });
      }

      // JSON format
      return { skills: rows.map(toPortableSkill) };
    },
    {
      query: t.Object({
        ids: t.Optional(t.String()),
        format: t.Optional(t.String()),
      }),
      detail: { tags: ['skills'] },
    }
  )

  // ---- Skill exchange bundles (docs/SKILL-EXCHANGE.md) ----

  .get(
    '/exchange/export',
    async ({ user, principal, query, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      const ids: string[] = [...new Set((query.ids as string).split(',').map((s: string) => s.trim()).filter(Boolean))];
      if (ids.length === 0) { set.status = 400; return { error: 'Name the skills to export: ids=<id>,<id>' }; }
      if (ids.length > MAX_BUNDLE_SKILLS) { set.status = 400; return { error: `A bundle carries at most ${MAX_BUNDLE_SKILLS} skills; export fewer at a time` }; }
      const mounted = ids.filter(isExternalSkillId);
      if (mounted.length > 0) {
        set.status = 400;
        return { error: 'Mounted skills are not exported: they can carry supporting files a bundle has no room for. Copy their SKILL.md folder instead.' };
      }
      // Same visibility as GET /export: an admin any row, a user system, own and their orgs'.
      const rows = isAdmin(principal) ? await skillRepository.findByIds(ids) : await skillRepository.findVisibleByIds(user.id, ids);
      if (rows.length !== ids.length) { set.status = 404; return { error: `${ids.length - rows.length} of the requested skills were not found` }; }
      const byId = new Map(rows.map(row => [row.id, row]));
      const bundle = buildBundle(ids.map(id => toBundleSkill(byId.get(id) as SkillView)));
      const result: SkillBundleExport = { bundle, signed: false, note: UNSIGNED_EXPORT_NOTE };
      return result;
    },
    {
      query: t.Object({ ids: t.String({ minLength: 1, maxLength: 20_000 }) }),
      detail: { tags: ['skills'] },
    }
  )

  // The configured skill registries' listings (docs/SKILL-EXCHANGE.md#registries):
  // browsing only. Installing one is a preview and an install like any import.
  .get(
    '/exchange/registry',
    async ({ user, principal, query, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      return listSkillRegistries(user.id, { q: query.q, tag: query.tag });
    },
    {
      query: t.Object({ q: t.Optional(t.String({ maxLength: 200 })), tag: t.Optional(t.String({ maxLength: 32 })) }),
      detail: { tags: ['skills'] },
    }
  )

  .post(
    '/exchange/preview',
    async ({ user, principal, session, body, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        return await previewImport(body, importActor(user.id, principal, session));
      } catch (error) {
        if (!(error instanceof SkillBundleError)) throw error;
        set.status = error.status;
        return { error: error.message };
      }
    },
    { body: IMPORT_SOURCE_BODY, detail: { tags: ['skills'] } }
  )

  .post(
    '/exchange/install',
    async ({ user, principal, session, body, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
      if (!requireScope(principal, API_SCOPES.WRITE)) { set.status = 403; return { error: `This token lacks the ${API_SCOPES.WRITE} scope` }; }
      const { contentHash, decisions, ...source } = body;
      try {
        return await installImport(source, contentHash, decisions ?? [], importActor(user.id, principal, session));
      } catch (error) {
        if (!(error instanceof SkillBundleError)) throw error;
        set.status = error.status;
        return { error: error.message };
      }
    },
    {
      body: t.Object({
        ...IMPORT_SOURCE_FIELDS,
        /** The content hash the preview showed: the install refuses anything else. */
        contentHash: t.String({ pattern: '^sha256:[0-9a-f]{64}$' }),
        decisions: t.Optional(t.Array(t.Union([
          t.Object({ name: t.String({ maxLength: 200 }), action: t.Literal('create') }),
          t.Object({ name: t.String({ maxLength: 200 }), action: t.Literal('skip') }),
          t.Object({ name: t.String({ maxLength: 200 }), action: t.Literal('rename'), newName: t.String({ maxLength: 200 }) }),
          t.Object({ name: t.String({ maxLength: 200 }), action: t.Literal('replace'), skillId: t.String({ minLength: 1, maxLength: 512 }) }),
        ]), { maxItems: MAX_BUNDLE_SKILLS })),
      }),
      detail: { tags: ['skills'] },
    }
  )

  // ---- Single-skill export (must be before generic /:id for path clarity) ----

  .get(
    '/:id/export',
    async ({ user, principal, params, query, set }) => {
      const format = query.format ?? 'json';
      // Admin: any row; user: system, own and their orgs'; anonymous: system only.
      const [skill] = user && isAdmin(principal) ? await skillRepository.findByIds([params.id])
        : user ? await skillRepository.findVisibleByIds(user.id, [params.id])
        : (await skillRepository.findByIds([params.id])).filter(row => row.isSystem);

      if (!skill) { set.status = 404; return { error: 'Skill not found' }; }

      if (format === 'markdown') {
        return new Response(skillToMarkdown(skill), {
          headers: {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Content-Disposition': `attachment; filename="${skill.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.md"`,
          },
        });
      }

      return toPortableSkill(skill);
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({
        format: t.Optional(t.String()),
      }),
      detail: { tags: ['skills'] },
    }
  )

  // ---- Standard CRUD routes ----

  .get(
    '/:id',
    async ({ user, params, set }) => {
      const skill = await getSkillRegistry().get(params.id, user?.id);
      if (!skill || (!user && !skill.isSystem)) { set.status = 404; return { error: 'Skill not found' }; }
      // The MCP server's get_skill loads a body through here (CLI agents);
      // the web Skills page lists skills and never reads one by id.
      if (!isExternalSkillId(skill.id)) recordSkillUsage([skill.id]);
      return skill;
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['skills'] },
    }
  )

  .post(
    '/',
    async ({ user, principal, session, body }) => {
      if (!user) return { error: 'Not authenticated' };

      const db = getDb();
      const [created] = await db.insert(skills).values({
        id: body.id ?? crypto.randomUUID(),
        name: body.name,
        category: body.category ?? 'general',
        description: body.description,
        content: body.content ?? '',
        principles: body.principles ?? [],
        bestPractices: body.bestPractices ?? [],
        antiPatterns: body.antiPatterns ?? [],
        frameworks: body.frameworks ?? [],
        isSystem: false,
        userId: user.id === 'system' ? null : user.id,
        // Created in person: the owner's own skill, locked against learning patches.
        ownerEditedAt: isInPersonWrite(principal, session) ? new Date() : null,
      }).returning();

      return created;
    },
    {
      body: t.Object({
        id: t.Optional(t.String()),
        name: t.String(),
        category: t.Optional(t.String()),
        description: t.String(),
        content: t.Optional(t.String()),
        principles: t.Optional(t.Array(t.String())),
        bestPractices: t.Optional(t.Array(t.String())),
        antiPatterns: t.Optional(t.Array(t.String())),
        frameworks: t.Optional(t.Array(t.String())),
      }),
      detail: { tags: ['skills'] },
    }
  )

  .patch(
    '/:id',
    async ({ user, principal, session, params, body, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        // The owner editing in person (web/mobile login, not an API token,
        // the MCP bridge or an impersonating admin) locks the skill against
        // learning patches (docs/SESSION-LEARNING.md#the-owner-edit-lock).
        return await updateSkill(params.id, body, user.id, { inPerson: isInPersonWrite(principal, session) });
      } catch (error) {
        if (!(error instanceof SkillUpdateError)) throw error;
        set.status = error.status;
        return { error: error.message };
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        name: t.Optional(t.String()),
        category: t.Optional(t.String()),
        description: t.Optional(t.String()),
        content: t.Optional(t.String()),
        principles: t.Optional(t.Array(t.String())),
        bestPractices: t.Optional(t.Array(t.String())),
        antiPatterns: t.Optional(t.Array(t.String())),
        frameworks: t.Optional(t.Array(t.String())),
      }),
      detail: { tags: ['skills'] },
    }
  )

  .delete(
    '/:id',
    async ({ user, params, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const ownerId = user.id;
      const registry = getSkillRegistry();
      const existing = await registry.get(params.id, ownerId);
      if (!existing) { set.status = 404; return { error: 'Skill not found' }; }
      if (existing.isSystem || isExternalSkillId(existing.id) || (existing.orgId && existing.userId !== ownerId)) {
        await hiddenSkillRepository.hide(ownerId, registry.sourceIds(existing.id));
        return { deleted: true, removal: 'personal' };
      }
      if (!user.isAdmin && existing.userId !== ownerId) { set.status = 403; return { error: 'Not authorized' }; }
      const db = getDb();
      return db.transaction(async tx => {
        await tx.delete(skillSelections).where(eq(skillSelections.skillId, existing.id));
        const result = await tx.delete(skills).where(eq(skills.id, existing.id)).returning();
        return { deleted: result.length > 0, removal: 'deleted' };
      });
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['skills'] },
    }
  );
