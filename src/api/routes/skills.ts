import { and, eq, inArray } from 'drizzle-orm';
import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { adminDenied } from '@/api/admin-guard';
import { getDb } from '@/db/postgres';
import { skillRepository, type SkillUpdate } from '@/db/repositories/skill-repository';
import { type Skill, skills } from '@/db/schema/skills';
import { hiddenSkillRepository } from '@/db/repositories/hidden-skill-repository';
import { skillSelections } from '@/db/schema/skill-selections';
import { isExternalSkillId } from '@/skills/external-loader';
import { getSkillRegistry } from '@/skills/registry';
import { updateSkill, SkillUpdateError } from '@/skills/update';
import { getSkillModes } from '@/skills/selection';
import { skillSelectionRepository } from '@/db/repositories/skill-selection-repository';
import { scopedRepos } from '@/db/repositories/scoped';
import { isAdmin, isAuthenticated } from '@/security/principal';
import {
  markdownToSkills,
  type PortableSkill,
  skillsToMarkdown,
  skillToMarkdown,
  toPortableSkill,
} from '@/skills/markdown';
import { canActInSession } from '@/core/rooms/access';

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

  // ---- Export / Import endpoints (must be before /:id) ----

  .get(
    '/export',
    async ({ user, principal, query }) => {
      const db = getDb();
      const format = query.format ?? 'json';

      let rows: Skill[];
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

  .post(
    '/import',
    async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }

      const db = getDb();
      const admin = isAdmin(principal);
      const overwrite = body.overwrite ?? false;
      let incoming: PortableSkill[] = [];

      if (body.skills && body.skills.length > 0) {
        incoming = body.skills;
      } else if (body.markdown) {
        incoming = markdownToSkills(body.markdown);
      } else {
        return { error: 'Provide either "skills" (JSON array) or "markdown" (string)' };
      }

      // Validate required fields
      for (const s of incoming) {
        if (!s.name || !s.description) {
          return { error: `Skill "${s.name ?? '(unnamed)'}" is missing required fields (name, description)` };
        }
      }

      // Look up existing skills by name for conflict detection. An admin
      // matches every row (and may overwrite any of them); anyone else only
      // the skills they can see, so another user's private skill neither
      // conflicts nor leaks its name. Their own copy wins a name clash.
      const owns = (row: Skill) => !row.isSystem && row.userId === user.id;
      const existingRows = admin ? await db.select().from(skills) : await skillRepository.findAll(user.id);
      const existingByName = new Map<string, Skill>();
      for (const row of existingRows) {
        const key = row.name.toLowerCase();
        if (!existingByName.has(key) || (!admin && owns(row))) existingByName.set(key, row);
      }

      const createdIds: string[] = [];
      const skipped: string[] = [];
      const updated: string[] = [];
      // Visible but not the caller's (system, org, shared): never overwritten
      // by a non-admin, and not duplicated either — reported here instead.
      const notOwned: string[] = [];

      for (const portable of incoming) {
        const existing = existingByName.get(portable.name.toLowerCase());

        if (existing) {
          if (!overwrite) {
            skipped.push(portable.name);
            continue;
          }
          if (!admin && !owns(existing)) {
            skipped.push(portable.name);
            notOwned.push(portable.name);
            continue;
          }

          // Update existing skill — go through the repository so the
          // description-embedding invalidation hook fires when description
          // changes (skill-discovery Phase 2).
          const updateData: SkillUpdate = {
            category: portable.category ?? existing.category,
            description: portable.description,
            content: portable.content ?? existing.content,
            principles: portable.principles ?? existing.principles,
            bestPractices: portable.bestPractices ?? existing.bestPractices,
            antiPatterns: portable.antiPatterns ?? existing.antiPatterns,
            frameworks: portable.frameworks ?? existing.frameworks,
          };

          await skillRepository.update(existing.id, updateData);
          updated.push(existing.id);
          continue;
        }

        // Create new skill
        const id = crypto.randomUUID();
        await db.insert(skills).values({
          id,
          name: portable.name,
          category: portable.category ?? 'general',
          description: portable.description,
          content: portable.content ?? '',
          principles: portable.principles ?? [],
          bestPractices: portable.bestPractices ?? [],
          antiPatterns: portable.antiPatterns ?? [],
          frameworks: portable.frameworks ?? [],
          isSystem: false,
          userId: user.id === 'system' ? null : user.id,
        });
        createdIds.push(id);
      }

      return { created: createdIds, updated, skipped, notOwned };
    },
    {
      body: t.Object({
        skills: t.Optional(
          t.Array(
            t.Object({
              name: t.String(),
              category: t.Optional(t.String()),
              description: t.String(),
              content: t.Optional(t.String()),
              principles: t.Optional(t.Array(t.String())),
              bestPractices: t.Optional(t.Array(t.String())),
              antiPatterns: t.Optional(t.Array(t.String())),
              frameworks: t.Optional(t.Array(t.String())),
            })
          )
        ),
        markdown: t.Optional(t.String()),
        overwrite: t.Optional(t.Boolean()),
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
      return skill;
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['skills'] },
    }
  )

  .post(
    '/',
    async ({ user, body }) => {
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
    async ({ user, params, body, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      try {
        return await updateSkill(params.id, body, user.id);
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
