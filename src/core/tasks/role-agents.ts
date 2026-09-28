/**
 * The tasks page's role-agents panel: which roles a user has work assigned
 * to, and whether each role's heartbeat agent is on.
 *
 * Per USER, across every workspace, on purpose: the role heartbeat hook
 * (`ensureRoleHeartbeatHook`) is one row per user and role, and its probe
 * (`probeRoleWork`) picks up the user's role tasks whatever workspace they
 * sit in. A workspace-scoped view here would show a different set of tasks
 * than the agent it toggles actually works.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { boardWritesAllowed, heartbeatRole, isRoleName } from '@/core/heartbeat';
import { ACTIVE_TASK_STATUSES } from '@/core/tasks/status';
import { getDb } from '@/db/postgres';
import { hooks } from '@/db/schema/hooks';
import { tasks } from '@/db/schema/tasks';

export interface RoleAgentRow {
  role: string;
  /** Open or in-progress tasks assigned to the role. */
  activeTasks: number;
  totalTasks: number;
  /** Any of the user's heartbeat hooks for this role is enabled. */
  enabled: boolean;
  /** The hook that runs (the enabled one, else the oldest), or null when none exists. */
  hookId: string | null;
  /** The role is in the registry (an unknown one cannot be turned on). */
  known: boolean;
}

export interface RoleAgentsView {
  roles: RoleAgentRow[];
  /** tasks/write is ALLOW for the user; without it a role turn cannot touch the board. */
  boardWritesAllowed: boolean;
  /** The server's heartbeat master switch (`heartbeat.enabled`); off, no role agent runs. */
  heartbeatEnabled: boolean;
}

/** Role task counts for one user, grouped in SQL. */
async function roleTaskCounts(userId: string): Promise<{ role: string; total: number; active: number }[]> {
  const rows = await getDb()
    .select({
      role: tasks.assigneeRef,
      total: sql<number>`count(*)::int`,
      active: sql<number>`(count(*) filter (where ${inArray(tasks.status, [...ACTIVE_TASK_STATUSES])}))::int`,
    })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.assigneeKind, 'role')))
    .groupBy(tasks.assigneeRef);
  return rows.filter((r): r is { role: string; total: number; active: number } => typeof r.role === 'string' && r.role !== '');
}

/** The user's role heartbeat hooks, enabled first then oldest (the order ensure keeps). */
async function roleHooks(userId: string) {
  return getDb()
    .select({ id: hooks.id, trigger: hooks.trigger, triggerConfig: hooks.triggerConfig, isEnabled: hooks.isEnabled })
    .from(hooks)
    .where(and(eq(hooks.userId, userId), eq(hooks.trigger, 'heartbeat'), sql`${hooks.triggerConfig}->>'role' IS NOT NULL`))
    .orderBy(sql`${hooks.isEnabled} DESC`, asc(hooks.createdAt), asc(hooks.id));
}

export async function listRoleAgents(userId: string): Promise<RoleAgentsView> {
  const [counts, hookRows, allowed, { ROLE_CONFIGS }] = await Promise.all([
    roleTaskCounts(userId),
    roleHooks(userId),
    boardWritesAllowed(userId),
    import('@/core/agent/roles'),
  ]);
  const rows = new Map<string, RoleAgentRow>();
  const row = (role: string): RoleAgentRow => {
    let r = rows.get(role);
    if (!r) {
      r = { role, activeTasks: 0, totalTasks: 0, enabled: false, hookId: null, known: Object.hasOwn(ROLE_CONFIGS, role) };
      rows.set(role, r);
    }
    return r;
  };
  for (const c of counts) Object.assign(row(c.role), { activeTasks: c.active, totalTasks: c.total });
  for (const hook of hookRows) {
    const role = heartbeatRole(hook);
    if (!role) continue;
    const r = row(role);
    // Ordered enabled-first: the first hook seen is the one that runs.
    if (r.hookId === null) r.hookId = hook.id;
    r.enabled ||= hook.isEnabled;
  }
  return {
    roles: [...rows.values()].sort((a, b) => a.role.localeCompare(b.role)),
    boardWritesAllowed: allowed,
    heartbeatEnabled: Boolean(getConfig().heartbeat?.enabled),
  };
}

/**
 * Why `role` cannot be switched to `enabled`, or null. Turning a role on
 * needs a registered role; turning one off only a well-formed name, so the
 * agent of a role since deleted can still be stopped.
 */
export async function roleAgentToggleError(role: string, enabled: boolean): Promise<string | null> {
  if (!isRoleName(role)) return `Invalid role "${role}"`;
  if (!enabled) return null;
  const { ROLE_CONFIGS } = await import('@/core/agent/roles');
  return Object.hasOwn(ROLE_CONFIGS, role) ? null : `Unknown role "${role}"`;
}
