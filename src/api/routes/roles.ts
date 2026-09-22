import { eq } from 'drizzle-orm';
import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import { ROLE_CONFIGS, removeRoleInMemory, setRoleInMemory, unknownToolIds } from '@/core/agent/roles';
import type { AgentRole, RoleConfig } from '@/core/agent/types';
import { getDb } from '@/db/postgres';
import { roles } from '@/db/schema/roles';
import { canonicalTopic, TOPICS } from '@/models/topics';
import { apiLogger } from '@/utils/logger';

/**
 * Role routes — read, edit, create and delete roles at runtime.
 *
 * The file registry (`roles/<name>/config.ts`) is the default/fallback for the
 * sixteen shipped roles; the DB row is the runtime override, loaded into
 * ROLE_CONFIGS at boot by `loadRolesFromDb`. A row with NO folder is a role the
 * user created, and it joins the registry the same way — which is what makes
 * these routes more than a tool-allowlist editor.
 *
 * Every write also updates the in-memory ROLE_CONFIGS, because that map is read
 * synchronously by `getToolsForRole` and the worker spawner: the mutation IS
 * the cache invalidation, and without it an edit takes effect at the next
 * restart instead of the next spawn.
 *
 * A role's LANE is its `defaultTopic` put through `canonicalTopic` — the same
 * resolution the model registry does. Nothing picks a role out of a lane; the
 * arrow runs role → lane, and a role is chosen by the model naming it in
 * `spawn_child` (from `description`) or by the user with `/role`.
 */

/** Role names are used as tool-enum values and topic-path segments. */
const ROLE_NAME = /^[a-z][a-z0-9_-]{1,31}$/;

const trimmedList = (raw: unknown): string[] =>
  Array.isArray(raw) ? [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))] : [];


/** The lane this role's work runs on, resolved the way the registry resolves it. */
const laneOf = (defaultTopic: string): string => canonicalTopic(defaultTopic);

/**
 * A lane a ROLE may run on: the text lanes, and nothing else.
 *
 * `TOPICS` also holds `ocr`, `vision` and `embedding` — model CLASSES, not
 * lanes — and `background`, which is where memory extraction and summarisation
 * run. A role bound to any of them resolves to a model that cannot serve a
 * tool-calling worker at all (`selectForWorker` in worker-spawner), so every
 * spawn of that role would fail. The UI's lane dropdown already filters to
 * `kind === 'text'`; this is the same rule where it is enforceable.
 */
const isRoleLane = (defaultTopic: string): boolean =>
  TOPICS.some((tp) => tp.value === laneOf(defaultTopic) && tp.kind === 'text');

export const roleRoutes = new Elysia({ prefix: '/roles' })
  .use(apiContext)

  // List roles with their current bindings (DB-backed, with the customized flag
  // so the UI can show "overridden vs default").
  .get(
    '/',
    async ({ user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const db = getDb();
      const rows = await db.select().from(roles);
      return {
        roles: rows
          // The registry is what a spawn can actually reach: a role whose folder
          // was removed leaves its row behind, and listing it offers an edit
          // that PATCH then rejects. A user-created role IS in the registry
          // (loadRolesFromDb puts it there), so this no longer filters those.
          .filter((r) => ROLE_CONFIGS[r.role as AgentRole] !== undefined)
          .map((r) => ({
            role: r.role,
            description: r.description ?? '',
            defaultTopic: r.defaultTopic,
            lane: laneOf(r.defaultTopic),
            toolIds: (r.toolIds as string[]) ?? [],
            coreToolIds: (r.coreToolIds as string[]) ?? [],
            readOnly: r.readOnly,
            customized: r.customized,
            isSystem: r.isSystem,
            // The prompt and the standing rules are what an operator WROTE, and
            // only an operator may edit them. Non-admins reach this route for
            // the role NAMES alone (the skills page assigns by role, the
            // pipeline editor picks one per step), so they get everything the
            // page they are on can use and nothing it cannot.
            ...(user.isAdmin
              ? { systemPromptTemplate: r.systemPromptTemplate, criticalRules: (r.criticalRules as string[]) ?? [] }
              : {}),
          }))
          .sort((a, b) => a.role.localeCompare(b.role)),
      };
    },
    { detail: { tags: ['roles'] } },
  )

  // Create a role (admin-only). Everything a folder can set, set from the UI.
  .post(
    '/',
    async ({ body, user, set }) => {
      if (!user?.isAdmin) {
        set.status = 403;
        return { error: 'Admin access required' };
      }

      const name = String(body.role ?? '').trim().toLowerCase();
      if (!ROLE_NAME.test(name)) {
        set.status = 400;
        return { error: 'role must be 2-32 chars: lowercase letters, digits, - or _, starting with a letter' };
      }
      if (ROLE_CONFIGS[name as AgentRole]) {
        set.status = 409;
        return { error: `Role already exists: ${name}` };
      }

      const toolIds = trimmedList(body.toolIds);
      const prompt = String(body.systemPromptTemplate ?? '').trim();
      // The same bar `loadRoles` holds a folder to. A role with no prompt or no
      // tools is registered but fails at spawn time, which is a worse outcome
      // than refusing to create it.
      if (!prompt || toolIds.length === 0) {
        set.status = 400;
        return { error: 'systemPromptTemplate and at least one toolId are required' };
      }
      const unknown = unknownToolIds(toolIds);
      if (unknown.length > 0) {
        set.status = 400;
        return { error: `unknown toolIds: ${unknown.join(', ')}` };
      }
      const defaultTopic = String(body.defaultTopic ?? 'everyday');
      if (!isRoleLane(defaultTopic)) {
        set.status = 400;
        return { error: `defaultTopic must resolve to a text lane (got '${defaultTopic}')` };
      }

      const row = {
        role: name,
        description: String(body.description ?? '').trim() || null,
        toolIds,
        // Invariant: coreToolIds ⊆ toolIds, enforced here as well as at load.
        coreToolIds: trimmedList(body.coreToolIds).filter((id) => toolIds.includes(id)),
        criticalRules: trimmedList(body.criticalRules),
        readOnly: Boolean(body.readOnly),
        defaultTopic,
        systemPromptTemplate: prompt,
        // The one field the UI cannot set: a user's role is never a system role,
        // and `isSystem` is what DELETE checks.
        isSystem: false,
        customized: true,
      };
      const db = getDb();
      const [created] = await db.insert(roles).values(row).returning();

      setRoleInMemory(name as AgentRole, {
        role: name as AgentRole,
        toolIds,
        coreToolIds: row.coreToolIds.length ? row.coreToolIds : undefined,
        criticalRules: row.criticalRules.length ? row.criticalRules : undefined,
        readOnly: row.readOnly || undefined,
        description: row.description ?? undefined,
        defaultTopic,
        systemPromptTemplate: prompt,
      });

      apiLogger.info({ role: name, by: user.id }, 'Role created');
      return { role: created.role, lane: laneOf(defaultTopic) };
    },
    {
      body: t.Object({
        role: t.String(),
        description: t.Optional(t.String()),
        toolIds: t.Array(t.String()),
        coreToolIds: t.Optional(t.Array(t.String())),
        criticalRules: t.Optional(t.Array(t.String())),
        defaultTopic: t.Optional(t.String()),
        systemPromptTemplate: t.String(),
        readOnly: t.Optional(t.Boolean()),
      }),
      detail: { tags: ['roles'] },
    },
  )

  // Edit a role (admin-only). Every field is optional: absent means unchanged.
  .patch(
    '/:role',
    async ({ params, body, user, set }) => {
      if (!user?.isAdmin) {
        set.status = 403;
        return { error: 'Admin access required' };
      }

      const roleName = params.role;
      const current = ROLE_CONFIGS[roleName as AgentRole];
      if (!current) {
        set.status = 404;
        return { error: `Unknown role: ${roleName}` };
      }

      // `customized` on EVERY edit: it is what stops the boot seed resyncing
      // this role from its folder, and a prompt or rule edit needs that guard
      // just as much as a tool edit does.
      const updates: Record<string, unknown> = { updatedAt: new Date(), customized: true };
      const patch: Partial<RoleConfig> = {};

      if (body.toolIds !== undefined) {
        const toolIds = trimmedList(body.toolIds);
        if (toolIds.length === 0) {
          set.status = 400;
          return { error: 'toolIds must not be empty — a role with no tools cannot run' };
        }
        const unknown = unknownToolIds(toolIds);
        if (unknown.length > 0) {
          set.status = 400;
          return { error: `unknown toolIds: ${unknown.join(', ')}` };
        }
        updates.toolIds = toolIds;
        patch.toolIds = toolIds;
      }
      // Re-intersect against whichever tool list ends up in force, so removing a
      // tool cannot leave the core set naming one the role no longer holds.
      const effectiveTools = (patch.toolIds ?? current.toolIds) as string[];
      if (body.coreToolIds !== undefined) {
        const core = trimmedList(body.coreToolIds).filter((id) => effectiveTools.includes(id));
        updates.coreToolIds = core;
        patch.coreToolIds = core.length ? core : undefined;
      } else if (patch.toolIds && current.coreToolIds) {
        const core = current.coreToolIds.filter((id) => effectiveTools.includes(id));
        updates.coreToolIds = core;
        patch.coreToolIds = core.length ? core : undefined;
      }
      if (body.criticalRules !== undefined) {
        const rules = trimmedList(body.criticalRules);
        updates.criticalRules = rules;
        patch.criticalRules = rules.length ? rules : undefined;
      }
      if (body.description !== undefined) {
        const description = body.description.trim();
        updates.description = description || null;
        patch.description = description || undefined;
      }
      if (body.systemPromptTemplate !== undefined) {
        const prompt = body.systemPromptTemplate.trim();
        if (!prompt) {
          set.status = 400;
          return { error: 'systemPromptTemplate must not be empty' };
        }
        updates.systemPromptTemplate = prompt;
        patch.systemPromptTemplate = prompt;
      }
      if (body.readOnly !== undefined) {
        updates.readOnly = body.readOnly;
        patch.readOnly = body.readOnly;
      }
      if (body.defaultTopic !== undefined) {
        if (!isRoleLane(body.defaultTopic)) {
          set.status = 400;
          return { error: `defaultTopic must resolve to a text lane (got '${body.defaultTopic}')` };
        }
        updates.defaultTopic = body.defaultTopic;
        patch.defaultTopic = body.defaultTopic;
      }

      const db = getDb();
      const [updated] = await db.update(roles).set(updates).where(eq(roles.role, roleName)).returning();
      if (!updated) {
        set.status = 404;
        return { error: `Role row not found: ${roleName}` };
      }

      // Invalidate the in-memory cache so the next spawn picks it up.
      setRoleInMemory(roleName as AgentRole, patch);

      apiLogger.info({ role: roleName, fields: Object.keys(updates), by: user.id }, 'Role updated');
      return {
        role: roleName,
        toolIds: (updated.toolIds as string[]) ?? [],
        lane: laneOf(updated.defaultTopic),
        customized: updated.customized,
      };
    },
    {
      params: t.Object({ role: t.String() }),
      body: t.Object({
        toolIds: t.Optional(t.Array(t.String())),
        coreToolIds: t.Optional(t.Array(t.String())),
        criticalRules: t.Optional(t.Array(t.String())),
        description: t.Optional(t.String()),
        defaultTopic: t.Optional(t.String()),
        systemPromptTemplate: t.Optional(t.String()),
        readOnly: t.Optional(t.Boolean()),
      }),
      detail: { tags: ['roles'] },
    },
  )

  // Delete a user-created role (admin-only). A system role has a folder behind
  // it, so deleting the row would only resurrect it at the next boot seed.
  .delete(
    '/:role',
    async ({ params, user, set }) => {
      if (!user?.isAdmin) {
        set.status = 403;
        return { error: 'Admin access required' };
      }
      const db = getDb();
      const [row] = await db.select().from(roles).where(eq(roles.role, params.role)).limit(1);
      if (!row) {
        set.status = 404;
        return { error: `Unknown role: ${params.role}` };
      }
      if (row.isSystem) {
        set.status = 400;
        return { error: `'${params.role}' ships with Octipus and cannot be deleted — edit it instead` };
      }

      await db.delete(roles).where(eq(roles.role, params.role));
      removeRoleInMemory(params.role as AgentRole);

      apiLogger.info({ role: params.role, by: user.id }, 'Role deleted');
      return { deleted: params.role };
    },
    { params: t.Object({ role: t.String() }), detail: { tags: ['roles'] } },
  );
