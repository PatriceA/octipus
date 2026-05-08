import { eq, inArray, or } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getDb } from '@/db/postgres';
import { type Skill, skills } from '@/db/schema/skills';
import { getUserOrgIds } from '@/services/org-membership';
import {
  markdownToSkills,
  type PortableSkill,
  skillsToMarkdown,
  skillToMarkdown,
  toPortableSkill,
} from '@/skills/markdown';

export const skillRoutes = new Elysia({ prefix: '/skills' })
  .use(apiContext)

  .get(
    '/',
    async ({ user }) => {
      const db = getDb();

      if (user) {
        if (user.id === 'system') {
          return { skills: await db.select().from(skills) };
        }
        const orgIds = await getUserOrgIds(user.id);
        const clauses = [eq(skills.isSystem, true), eq(skills.userId, user.id)];
        if (orgIds.length > 0) clauses.push(inArray(skills.orgId, orgIds));
        return {
          skills: await db.select().from(skills).where(or(...clauses)),
        };
      }

      return {
        skills: await db.select().from(skills).where(eq(skills.isSystem, true)),
      };
    },
    { detail: { tags: ['skills'] } }
  )

  // ---- Export / Import endpoints (must be before /:id) ----

  .get(
    '/export',
    async ({ user, query }) => {
      const db = getDb();
      const format = query.format ?? 'json';

      let rows;
      if (query.ids) {
        const idList = query.ids.split(',').map((s) => s.trim()).filter(Boolean);
        rows = await db.select().from(skills).where(inArray(skills.id, idList));
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
    async ({ user, body }) => {
      if (!user) return { error: 'Not authenticated' };

      const db = getDb();
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

      // Look up existing skills by name for conflict detection
      const existingRows = await db.select().from(skills);
      const existingByName = new Map<string, Skill>(existingRows.map((r) => [r.name.toLowerCase(), r]));

      const createdIds: string[] = [];
      const skipped: string[] = [];
      const updated: string[] = [];

      for (const portable of incoming) {
        const existing = existingByName.get(portable.name.toLowerCase());

        if (existing) {
          if (!overwrite) {
            skipped.push(portable.name);
            continue;
          }

          // Update existing skill
          const updateData: Record<string, unknown> = {
            category: portable.category ?? existing.category,
            description: portable.description,
            content: portable.content ?? existing.content,
            principles: portable.principles ?? existing.principles,
            bestPractices: portable.bestPractices ?? existing.bestPractices,
            antiPatterns: portable.antiPatterns ?? existing.antiPatterns,
            frameworks: portable.frameworks ?? existing.frameworks,
            updatedAt: new Date(),
          };

          await db.update(skills).set(updateData).where(eq(skills.id, existing.id));
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

      return { created: createdIds, updated, skipped };
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
    async ({ user, params, query }) => {
      const db = getDb();
      const format = query.format ?? 'json';
      const [skill] = await db.select().from(skills).where(eq(skills.id, params.id)).limit(1);

      if (!skill) return { error: 'Skill not found' };

      if (!skill.isSystem && user && !user.isAdmin && skill.userId !== user.id) {
        return { error: 'Not authorized' };
      }

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
    async ({ user, params }) => {
      const db = getDb();
      const [skill] = await db.select().from(skills).where(eq(skills.id, params.id)).limit(1);

      if (!skill) return { error: 'Skill not found' };

      if (!skill.isSystem && user && !user.isAdmin && skill.userId !== user.id) {
        return { error: 'Not authorized' };
      }

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
    async ({ user, params, body }) => {
      if (!user) return { error: 'Not authenticated' };

      const db = getDb();
      const [existing] = await db.select().from(skills).where(eq(skills.id, params.id)).limit(1);

      if (!existing) return { error: 'Skill not found' };
      // System skills can be edited by any authenticated user; custom skills only by owner or admin
      if (!existing.isSystem && !user.isAdmin && existing.userId !== user.id) return { error: 'Not authorized' };

      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) updateData.name = body.name;
      if (body.category !== undefined) updateData.category = body.category;
      if (body.description !== undefined) updateData.description = body.description;
      if (body.content !== undefined) updateData.content = body.content;
      if (body.principles !== undefined) updateData.principles = body.principles;
      if (body.bestPractices !== undefined) updateData.bestPractices = body.bestPractices;
      if (body.antiPatterns !== undefined) updateData.antiPatterns = body.antiPatterns;
      if (body.frameworks !== undefined) updateData.frameworks = body.frameworks;

      const [updated] = await db
        .update(skills)
        .set(updateData)
        .where(eq(skills.id, params.id))
        .returning();

      return updated;
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
    async ({ user, params }) => {
      if (!user) return { error: 'Not authenticated' };

      const db = getDb();
      const [existing] = await db.select().from(skills).where(eq(skills.id, params.id)).limit(1);

      if (!existing) return { error: 'Skill not found' };
      if (existing.isSystem) return { error: 'Cannot delete system skills' };
      if (!user.isAdmin && existing.userId !== user.id) return { error: 'Not authorized' };

      const result = await db.delete(skills).where(eq(skills.id, params.id)).returning();
      return { deleted: result.length > 0 };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['skills'] },
    }
  );
