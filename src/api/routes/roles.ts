import { eq } from 'drizzle-orm';
import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import { ROLE_CONFIGS, setRoleInMemory, unknownToolIds } from '@/core/agent/roles';
import {
  describeSource, isBuiltinRole, isRegisteredRole, isRoleLane, listRegisteredRoles, newRoleIdProblem, RoleDefinitionError,
  registerRuntimeRole, roleSource, setUnloadedRole, unloadedRoleProblems, unregisterRuntimeRole,
} from '@/core/agent/role-registry';
import type { RoleConfig } from '@/core/agent/types';
import { getDb } from '@/db/postgres';
import { type Role, roles } from '@/db/schema/roles';
import { roleDefinitionOfRow } from '@/db/seed-roles';
import { canonicalTopic } from '@/models/topics';
import { withoutRetiredToolIds } from '@/core/agent/retired-tools';
import { apiLogger } from '@/utils/logger';

/**
 * Role routes — read, edit, create and delete roles at runtime.
 *
 * The file registry (`roles/<name>/config.ts`) is the default/fallback for the
 * shipped roles; the DB row is the runtime override, loaded into ROLE_CONFIGS
 * at boot by `loadRolesFromDb`. A row with NO folder is a role an operator
 * created — a runtime role, checked by the role registry (`role-registry.ts`)
 * on the way in and again at every boot. Roles a plugin package contributes
 * are listed here too, read-only: they change with their package.
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

const trimmedList = (raw: unknown): string[] =>
  Array.isArray(raw) ? [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))] : [];


/** The lane this role's work runs on, resolved the way the registry resolves it. */
const laneOf = (defaultTopic: string): string => canonicalTopic(defaultTopic);

/** The optional runtime-role fields a body may carry. `null` clears a rule. */
const spawnRule = t.Optional(t.Union([t.Array(t.String()), t.Null()]));
const limitsBody = t.Optional(t.Union([
  t.Object({ maxTokens: t.Optional(t.Number()), maxWallClockMs: t.Optional(t.Number()) }),
  t.Null(),
]));

/** A refused definition as a response: 409 for a clash with what is registered, 400 otherwise. */
function refusal(set: { status?: number | string }, err: unknown): { error: string; problems: string[] } {
  if (err instanceof RoleDefinitionError) {
    set.status = err.conflict ? 409 : 400;
    return { error: err.problems.join('; '), problems: err.problems };
  }
  throw err;
}

/** Why a plugin's role cannot be changed here, or null. */
function pluginOwned(role: string): string | null {
  const source = roleSource(role);
  return source?.kind === 'plugin'
    ? `'${role}' is contributed by ${describeSource(source)}; change it there (disable or uninstall the package to remove it)`
    : null;
}

/** Register an operator's row (or the row an edit would leave) as a runtime role; throws `RoleDefinitionError`. */
function registerRow(row: Role): void {
  // The tool REGISTRY was consulted by `unknownToolIds` already (open on a
  // cold registry, as it always was); the registry still applies the ceiling.
  registerRuntimeRole(roleDefinitionOfRow(row), { kind: 'admin' }, { checkRegisteredTools: false });
}

export const roleRoutes = new Elysia({ prefix: '/roles' })
  .use(apiContext)

  // List the registered roles: the built-ins and operator roles with their
  // stored row (the customized flag lets the UI show "overridden vs default"),
  // and the roles enabled plugin packages contribute, which have no row.
  .get(
    '/',
    async ({ user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const db = getDb();
      const rows = new Map((await db.select().from(roles)).map((r) => [r.role, r]));
      // An operator's row the boot load could not register: listed with why,
      // so it can be edited back into shape or deleted rather than vanish.
      const unloadedRows = [...rows.values()]
        .filter((r) => !r.isSystem && !isRegisteredRole(r.role))
        .map((r) => ({
          role: r.role,
          displayName: r.displayName ?? null,
          description: r.description ?? '',
          defaultTopic: r.defaultTopic,
          lane: laneOf(r.defaultTopic),
          toolIds: withoutRetiredToolIds((r.toolIds as string[]) ?? []),
          coreToolIds: withoutRetiredToolIds((r.coreToolIds as string[]) ?? []),
          readOnly: r.readOnly,
          customized: r.customized,
          isSystem: false,
          source: 'admin' as const,
          plugin: null,
          spawns: r.spawns ?? null,
          spawnedBy: r.spawnedBy ?? null,
          limits: r.limits ?? null,
          loaded: false,
          problems: unloadedRoleProblems(r.role) ?? ['not registered'],
          ...(user.isAdmin ? { systemPromptTemplate: r.systemPromptTemplate, criticalRules: (r.criticalRules as string[]) ?? [] } : {}),
        }));
      return {
        // The registry is what a spawn can actually reach: a role whose folder
        // was removed leaves its row behind, and listing it offers an edit
        // that PATCH then rejects.
        roles: listRegisteredRoles()
          .filter(({ config, source }) => source.kind === 'plugin' || rows.has(config.role))
          .map(({ config, source }) => {
            const r = rows.get(config.role);
            return {
              role: config.role as string,
              displayName: config.displayName ?? null,
              description: (r ? r.description : config.description) ?? '',
              defaultTopic: config.defaultTopic,
              lane: laneOf(config.defaultTopic),
              // A removed built-in tool still named in the row is not offered:
              // the editor sends this list back on save.
              toolIds: withoutRetiredToolIds(r ? ((r.toolIds as string[]) ?? []) : config.toolIds),
              coreToolIds: withoutRetiredToolIds(r ? ((r.coreToolIds as string[]) ?? []) : config.coreToolIds ?? []),
              readOnly: r ? r.readOnly : Boolean(config.readOnly),
              customized: r?.customized ?? false,
              isSystem: source.kind === 'builtin',
              /** `builtin`, `admin` (an operator's row) or `plugin` (read-only here). */
              source: source.kind,
              plugin: source.kind === 'plugin' ? source.plugin : null,
              spawns: config.spawns ?? null,
              spawnedBy: config.spawnedBy ?? null,
              limits: config.limits ?? null,
              loaded: true,
              problems: [] as string[],
              // The prompt and the standing rules are what an operator (or an
              // approved plugin) WROTE, and only an operator may read them back.
              // Non-admins reach this route for the role NAMES alone (the skills
              // page assigns by role, the pipeline editor picks one per step),
              // so they get everything the page they are on can use and nothing
              // it cannot.
              ...(user.isAdmin
                ? {
                    systemPromptTemplate: r?.systemPromptTemplate ?? config.systemPromptTemplate,
                    criticalRules: r ? ((r.criticalRules as string[]) ?? []) : config.criticalRules ?? [],
                  }
                : {}),
            };
          })
          .concat(unloadedRows)
          .sort((a, b) => a.role.localeCompare(b.role)),
      };
    },
    { detail: { tags: ['roles'] } },
  )

  // Create a role (admin-only): a runtime role, checked by the role registry,
  // which refuses a built-in or reserved id, an id another source owns, a tool
  // no built-in role holds and a lane that is not a text lane.
  .post(
    '/',
    async ({ body, user, set }) => {
      if (!user?.isAdmin) {
        set.status = 403;
        return { error: 'Admin access required' };
      }

      const name = String(body.role ?? '').trim().toLowerCase();
      if (isRegisteredRole(name)) {
        set.status = 409;
        return { error: `Role already exists: ${name} (registered by ${describeSource(roleSource(name) ?? { kind: 'builtin' })})` };
      }
      const db = getDb();
      // A stored row that is not registered (it did not load) still owns its
      // id: edit or delete it. Checked here so this is a 409, not the table's
      // unique-constraint error.
      const [stored] = await db.select({ role: roles.role }).from(roles).where(eq(roles.role, name)).limit(1);
      if (stored) {
        set.status = 409;
        return { error: `A stored role already has the id ${name}; edit or delete it` };
      }
      // A new id only: a stored row that predates the reserved list keeps loading.
      const reserved = /^[a-z][a-z0-9_-]{1,31}$/.test(name) ? newRoleIdProblem(name) : null;
      if (reserved) {
        set.status = 400;
        return { error: reserved, problems: [reserved] };
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

      const row = {
        role: name,
        description: String(body.description ?? '').trim() || null,
        displayName: String(body.displayName ?? '').trim() || null,
        toolIds,
        // Invariant: coreToolIds ⊆ toolIds, enforced here as well as at load.
        coreToolIds: trimmedList(body.coreToolIds).filter((id) => toolIds.includes(id)),
        criticalRules: trimmedList(body.criticalRules),
        readOnly: Boolean(body.readOnly),
        defaultTopic,
        systemPromptTemplate: prompt,
        spawns: body.spawns ?? null,
        spawnedBy: body.spawnedBy ?? null,
        limits: body.limits ?? null,
        // The one field the UI cannot set: a user's role is never a system role,
        // and `isSystem` is what DELETE checks.
        isSystem: false,
        customized: true,
      };
      // Registered first, so a definition the registry refuses never reaches the table.
      try {
        registerRow(row as Role);
      } catch (err) {
        return refusal(set, err);
      }
      let created: Role;
      try {
        [created] = await db.insert(roles).values(row).returning();
      } catch (err) {
        unregisterRuntimeRole(name, { kind: 'admin' });
        throw err;
      }

      apiLogger.info({ role: name, by: user.id }, 'Role created');
      return { role: created.role, lane: laneOf(defaultTopic) };
    },
    {
      body: t.Object({
        role: t.String(),
        displayName: t.Optional(t.String()),
        description: t.Optional(t.String()),
        toolIds: t.Array(t.String()),
        coreToolIds: t.Optional(t.Array(t.String())),
        criticalRules: t.Optional(t.Array(t.String())),
        defaultTopic: t.Optional(t.String()),
        systemPromptTemplate: t.String(),
        readOnly: t.Optional(t.Boolean()),
        spawns: spawnRule,
        spawnedBy: spawnRule,
        limits: limitsBody,
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
      const owned = pluginOwned(roleName);
      if (owned) {
        set.status = 409;
        return { error: owned };
      }
      const db = getDb();
      const [row] = await db.select().from(roles).where(eq(roles.role, roleName)).limit(1);
      // A registered role, or an operator's row that did not load (an edit is
      // how it is repaired).
      const repairable = !!row && !row.isSystem && unloadedRoleProblems(roleName) !== null;
      if (!isRegisteredRole(roleName) && !repairable) {
        set.status = 404;
        return { error: `Unknown role: ${roleName}` };
      }
      if (!row) {
        set.status = 404;
        return { error: `Role row not found: ${roleName}` };
      }
      const current: Pick<RoleConfig, 'toolIds' | 'coreToolIds'> = isRegisteredRole(roleName)
        ? ROLE_CONFIGS[roleName]
        : { toolIds: (row.toolIds as string[]) ?? [], coreToolIds: (row.coreToolIds as string[]) ?? [] };
      const builtin = isBuiltinRole(roleName);
      // Spawn rules, limits and a display name belong to runtime roles: a
      // built-in's place in the swarm is fixed by the code that ships it.
      if (builtin && (body.spawns !== undefined || body.spawnedBy !== undefined || body.limits !== undefined || body.displayName !== undefined)) {
        set.status = 400;
        return { error: `'${roleName}' is a built-in role: spawns, spawnedBy, limits and displayName apply to runtime roles only` };
      }

      // `customized` on EVERY edit: it is what stops the boot seed resyncing
      // this role from its folder, and a prompt or rule edit needs that guard
      // just as much as a tool edit does.
      const updates: Record<string, unknown> = { updatedAt: new Date(), customized: true };
      const patch: Partial<RoleConfig> = {};

      if (body.toolIds !== undefined) {
        // A list read back from a row saved before a tool was removed still
        // names it; drop it rather than refuse the whole edit.
        const toolIds = withoutRetiredToolIds(trimmedList(body.toolIds));
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
      if (body.displayName !== undefined) updates.displayName = body.displayName.trim() || null;
      if (body.spawns !== undefined) updates.spawns = body.spawns;
      if (body.spawnedBy !== undefined) updates.spawnedBy = body.spawnedBy;
      if (body.limits !== undefined) updates.limits = body.limits;

      // An operator's role is a runtime role: the edited whole is checked by
      // the registry (and takes effect) before it is written, so an edit cannot
      // take it where a create could not.
      if (!builtin) {
        try {
          registerRow({ ...row, ...updates } as Role);
        } catch (err) {
          return refusal(set, err);
        }
      }
      let updated: Role | undefined;
      try {
        [updated] = await db.update(roles).set(updates).where(eq(roles.role, roleName)).returning();
      } catch (err) {
        // The registry already took the edit; put the stored definition back.
        // That can itself be refused (a row that never loaded): then the role
        // is left out of the registry and listed as not loaded, never left
        // registered with an edit the table does not hold.
        if (!builtin) {
          try {
            registerRow(row);
          } catch (restoreErr) {
            unregisterRuntimeRole(roleName, { kind: 'admin' });
            const problems = restoreErr instanceof RoleDefinitionError ? restoreErr.problems : [(restoreErr as Error).message];
            setUnloadedRole(roleName, problems);
            apiLogger.error({ role: roleName, err: restoreErr }, 'Role edit failed and the stored definition could not be restored to the registry');
          }
        }
        throw err;
      }
      if (!updated) {
        set.status = 404;
        return { error: `Role row not found: ${roleName}` };
      }

      // Invalidate the in-memory cache so the next spawn picks it up (a
      // runtime role was re-registered above).
      if (builtin) setRoleInMemory(roleName, patch);

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
        displayName: t.Optional(t.String()),
        defaultTopic: t.Optional(t.String()),
        systemPromptTemplate: t.Optional(t.String()),
        readOnly: t.Optional(t.Boolean()),
        spawns: spawnRule,
        spawnedBy: spawnRule,
        limits: limitsBody,
      }),
      detail: { tags: ['roles'] },
    },
  )

  // Delete an operator's role (admin-only). A system role has a folder behind
  // it, so deleting the row would only resurrect it at the next boot seed; a
  // plugin's role goes with its package.
  .delete(
    '/:role',
    async ({ params, user, set }) => {
      if (!user?.isAdmin) {
        set.status = 403;
        return { error: 'Admin access required' };
      }
      const owned = pluginOwned(params.role);
      if (owned) {
        set.status = 409;
        return { error: owned };
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
      // Agents already running as it finish; a stage, hook or child that names
      // it later fails with `UnknownRoleError` rather than running as another role.
      unregisterRuntimeRole(params.role, { kind: 'admin' });
      setUnloadedRole(params.role, null);

      apiLogger.info({ role: params.role, by: user.id }, 'Role deleted');
      return { deleted: params.role };
    },
    { params: t.Object({ role: t.String() }), detail: { tags: ['roles'] } },
  );
