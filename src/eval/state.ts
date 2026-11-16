/**
 * End-state checks and fixtures for the eval harness (after n8n's nod evals:
 * "the score comes from what actually changed, not from what the agent said").
 *
 * A reply can say "I won't remember that" while the memory extractor saves it
 * anyway, and a Companion check-in can say "nothing to do" after queueing a
 * message to a session. Text assertions cannot see either. `db_rows` counts the
 * rows a turn left behind, scoped to the eval user, and fixtures put the rows a
 * scenario needs (a task carrying a planted instruction, a Companion goal with
 * a session report) in place before the turn and take them out after it.
 *
 * Every table is on an allowlist with the rule that scopes it to the eval user:
 * a check can never count — and a fixture can never touch — another user's
 * rows. Unknown tables, columns and references are setup errors, never a pass.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, getTableColumns, getTableName, gte, type SQL, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { companionActions, companionEvents, companionGoals, companionIncidents, companionReports, companionSessionLinks,
  companionSettings, companionWakes } from '@/db/schema/companion-supervision';
import { memories } from '@/db/schema/memories';
import { messages } from '@/db/schema/messages';
import { notifications } from '@/db/schema/notifications';
import { sessions } from '@/db/schema/sessions';
import { tasks } from '@/db/schema/tasks';

/** Rows to count. Columns are named as in SQL (`token_budget`) or in the schema (`tokenBudget`). */
export interface StateQuery {
  table: string;
  /** Equality per column; `null` is IS NULL, a list is IN. `basis.source` reads a JSON field. */
  where?: Record<string, unknown>;
  /** Case-insensitive POSIX regular expression per text column (or JSON field). */
  matches?: Record<string, string>;
  count?: number;
  min?: number;
  max?: number;
  /** `test` (default): only rows created after the fixtures were in place. `all`: any of the user's rows. */
  since?: 'test' | 'all';
}

export interface StateScope {
  userId: string;
  workspaceId?: string;
  /** Rows created before this are the fixtures' or older; `since: test` ignores them. */
  since: Date;
  /** `$name` → id of a fixture row, plus `$user` and `$workspace`. */
  refs?: Record<string, string>;
}

/** One row to insert before the turn. `as` names it for `$name` references in later rows and checks. */
export interface FixtureRow {
  table: string;
  as?: string;
  values: Record<string, unknown>;
}

export class StateSetupError extends Error {
  constructor(message: string) { super(message); this.name = 'StateSetupError'; }
}

type Scope = 'user' | 'user_workspace' | 'goal' | 'session' | 'settings';
interface Entry { table: PgTable; scope: Scope; defaults?: () => Record<string, unknown> }

const TABLES: Record<string, Entry> = {
  memories: { table: memories, scope: 'user' },
  notifications: { table: notifications, scope: 'user' },
  tasks: { table: tasks, scope: 'user' },
  sessions: { table: sessions, scope: 'user', defaults: () => ({ channelType: 'webchat', channelId: randomUUID() }) },
  messages: { table: messages, scope: 'session' },
  companion_settings: { table: companionSettings, scope: 'user_workspace' },
  companion_goals: { table: companionGoals, scope: 'user_workspace', defaults: () => ({ requestKey: randomUUID() }) },
  companion_reports: { table: companionReports, scope: 'user_workspace' },
  companion_actions: { table: companionActions, scope: 'goal', defaults: () => ({ requestKey: randomUUID() }) },
  companion_incidents: { table: companionIncidents, scope: 'goal' },
  companion_session_links: { table: companionSessionLinks, scope: 'goal' },
  companion_events: { table: companionEvents, scope: 'goal' },
  companion_wakes: { table: companionWakes, scope: 'settings' },
};

export const STATE_TABLES = Object.keys(TABLES);

/**
 * Assertion types that are `db_rows` with the table preset. `memory_absent`
 * is the poisoning check: `value` is a pattern no memory of the user may match.
 */
export const STATE_TABLE_ASSERTIONS: Record<string, string> = {
  memories: 'memories', memory_absent: 'memories', notifications: 'notifications', tasks: 'tasks',
  companion_goals: 'companion_goals', companion_actions: 'companion_actions',
  companion_reports: 'companion_reports', companion_incidents: 'companion_incidents',
};

/** Every assertion type that reads the database rather than the reply. */
export const STATE_ASSERTION_TYPES: ReadonlySet<string> = new Set(['db_rows', ...Object.keys(STATE_TABLE_ASSERTIONS)]);

/** `memory_absent`: no memory of the eval user (created in the window) matches `pattern`. */
export function memoryAbsentQuery(pattern: unknown, since?: StateQuery['since']): StateQuery {
  if (typeof pattern !== 'string' || !pattern) throw new StateSetupError('memory_absent needs a value: the pattern no memory may match.');
  return { table: 'memories', matches: { content: pattern }, count: 0, ...(since ? { since } : {}) };
}

/**
 * The query a state assertion stands for, from its YAML fields (`table`,
 * `where`, `matches`, `count`/`min`/`max`, `since`) or from an already-built
 * `query`. One builder for the loader and the evaluator.
 */
export function stateQueryFor(type: string, fields: Record<string, unknown>): StateQuery {
  const prebuilt = fields.query as StateQuery | undefined;
  const since = (prebuilt?.since ?? fields.since) as StateQuery['since'] | undefined;
  if (since !== undefined && since !== 'test' && since !== 'all') throw new StateSetupError('since must be "test" or "all".');
  if (type === 'memory_absent') return memoryAbsentQuery(fields.value, since);
  if (prebuilt) return { ...prebuilt, table: prebuilt.table || STATE_TABLE_ASSERTIONS[type] || '' };
  // The YAML parser reads `{ a: b }` flow mappings as a string; refuse rather
  // than drop the filter and count every row.
  for (const field of ['where', 'matches'] as const) {
    const v = fields[field];
    if (v !== undefined && (typeof v !== 'object' || v === null || Array.isArray(v))) {
      throw new StateSetupError(`${field} must be a block mapping (one "column: value" per line)`);
    }
  }
  const table = typeof fields.table === 'string' ? fields.table : STATE_TABLE_ASSERTIONS[type];
  if (!table) throw new StateSetupError(`${type} needs a table.`);
  const num = (k: 'count' | 'min' | 'max') => (typeof fields[k] === 'number' ? { [k]: fields[k] as number } : {});
  return {
    table,
    ...(fields.where ? { where: fields.where as Record<string, unknown> } : {}),
    ...(fields.matches ? { matches: fields.matches as Record<string, string> } : {}),
    ...num('count'), ...num('min'), ...num('max'),
    ...(since ? { since } : {}),
  };
}

function entry(name: string): Entry {
  const found = TABLES[name];
  if (!found) throw new StateSetupError(`Table "${name}" is not readable by evals. Use one of: ${STATE_TABLES.join(', ')}.`);
  return found;
}

const columns = (table: PgTable) => getTableColumns(table) as Record<string, PgColumn>;

function column(table: PgTable, name: string): { key: string; col: PgColumn } {
  for (const [key, col] of Object.entries(columns(table))) if (key === name || col.name === name) return { key, col };
  throw new StateSetupError(`Table "${getTableName(table)}" has no column "${name}".`);
}

/** A column, or one field inside a JSON column (`basis.source`, `context.clearedAt`). */
function expression(table: PgTable, name: string): SQL {
  const [head, ...path] = name.split('.');
  const { col } = column(table, head);
  if (!path.length) return sql`${col}`;
  return sql`(${col} #>> ${`{${path.join(',')}}`})`;
}

const REF = /^\$[A-Za-z_][\w-]*$/;

const ENV_REF = /^\$env:([A-Z][A-Z0-9_]*)$/;

/**
 * `$name` → a fixture row's id (or `$user` / `$workspace`); `$env:NAME` → an
 * environment variable, for values that differ per install (the controller
 * model a Companion fixture runs on). Anything else is taken as written.
 */
export function resolveRef(value: unknown, refs: Record<string, string>): unknown {
  const env = typeof value === 'string' ? ENV_REF.exec(value) : null;
  if (env) {
    const found = process.env[env[1]];
    if (!found) throw new StateSetupError(`Set ${env[1]} in the environment: a fixture reads it.`);
    return found;
  }
  if (typeof value === 'string' && REF.test(value)) {
    const id = refs[value.slice(1)];
    if (id === undefined) throw new StateSetupError(`Unknown reference ${value}: name the fixture row with "as" before using it.`);
    return id;
  }
  if (Array.isArray(value)) return value.map(v => resolveRef(v, refs));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRef(v, refs)]));
  return value;
}

export function scopeRefs(scope: Pick<StateScope, 'userId' | 'workspaceId' | 'refs'>): Record<string, string> {
  return { ...(scope.refs ?? {}), user: scope.userId, ...(scope.workspaceId ? { workspace: scope.workspaceId } : {}) };
}

/** The rule that keeps a table to the eval user's rows. */
function scoped(name: string, scope: Pick<StateScope, 'userId' | 'workspaceId'>): SQL {
  const { table, scope: rule } = entry(name);
  const cols = columns(table);
  const goalsOfUser = sql`(SELECT id FROM companion_goals WHERE user_id = ${scope.userId}${scope.workspaceId ? sql` AND workspace_id = ${scope.workspaceId}` : sql``})`;
  switch (rule) {
    case 'user': return eq(cols.userId, scope.userId);
    case 'user_workspace': return scope.workspaceId
      ? and(eq(cols.userId, scope.userId), eq(cols.workspaceId, scope.workspaceId)) as SQL
      : eq(cols.userId, scope.userId);
    case 'goal': return sql`${cols.goalId} IN ${goalsOfUser}`;
    case 'session': return sql`${cols.sessionId} IN (SELECT id FROM sessions WHERE user_id = ${scope.userId})`;
    case 'settings': return sql`${cols.settingsId} IN (SELECT id FROM companion_settings WHERE user_id = ${scope.userId})`;
  }
}

/** Build the WHERE of a state query. Exported for tests; throws StateSetupError on a bad query. */
export function stateConditions(query: StateQuery, scope: StateScope): SQL {
  const { table } = entry(query.table);
  const refs = scopeRefs(scope);
  const parts: SQL[] = [scoped(query.table, scope)];
  for (const [name, raw] of Object.entries(query.where ?? {})) {
    const value = resolveRef(raw, refs);
    const expr = expression(table, name);
    if (value === null) parts.push(sql`${expr} IS NULL`);
    else if (Array.isArray(value)) parts.push(value.length ? sql`${expr}::text IN (${sql.join(value.map(v => sql`${String(v)}`), sql`, `)})` : sql`false`);
    else parts.push(sql`${expr}::text = ${String(value)}`);
  }
  for (const [name, pattern] of Object.entries(query.matches ?? {})) parts.push(sql`${expression(table, name)} ~* ${String(pattern)}`);
  if ((query.since ?? 'test') === 'test') {
    const created = columns(table).createdAt;
    if (!created) {
      if (query.since === 'test') throw new StateSetupError(`Table "${query.table}" has no created_at; use since: all.`);
    } else parts.push(gte(created, scope.since));
  }
  return and(...parts) as SQL;
}

/** Count the rows a query selects. */
export async function countRows(query: StateQuery, scope: StateScope): Promise<{ count: number; ids: string[] }> {
  const { getDb } = await import('@/db/postgres');
  const { table } = entry(query.table);
  const cols = columns(table);
  const pk = cols.id ?? cols.seq;
  const where = stateConditions(query, scope);
  const [{ n }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(table).where(where);
  const ids = pk && n > 0 ? (await getDb().select({ id: sql<string>`${pk}::text` }).from(table).where(where).limit(5)).map(r => r.id) : [];
  return { count: Number(n), ids };
}

/** Does a count satisfy the query's expectation? Throws when the query states none. */
export function expectationMet(query: Pick<StateQuery, 'count' | 'min' | 'max'>, count: number): boolean {
  if (query.count === undefined && query.min === undefined && query.max === undefined)
    throw new StateSetupError('A state assertion needs count, min or max (count: 0 means "no such row").');
  return (query.count === undefined || count === query.count)
    && (query.min === undefined || count >= query.min)
    && (query.max === undefined || count <= query.max);
}

export function describeExpectation(query: Pick<StateQuery, 'count' | 'min' | 'max'>): string {
  if (query.count !== undefined) return query.count === 0 ? 'no rows' : `exactly ${query.count}`;
  return [query.min !== undefined ? `at least ${query.min}` : '', query.max !== undefined ? `at most ${query.max}` : ''].filter(Boolean).join(' and ');
}

const RELATIVE = /^-(\d+)(s|m|h|d)$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

function toDate(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const rel = RELATIVE.exec(value);
  if (rel) return new Date(Date.now() - Number(rel[1]) * UNIT_MS[rel[2] as keyof typeof UNIT_MS]);
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new StateSetupError(`"${value}" is not a time: use ISO 8601 or a relative "-5m".`);
  return at;
}

export interface InsertedFixtures {
  refs: Record<string, string>;
  /** In insertion order; deleted in reverse. */
  created: Array<{ table: string; id: string }>;
}

/**
 * Insert fixture rows for the eval user. `userId`/`workspaceId` columns are
 * filled from the scope unless given, `$name` resolves to an earlier row's id,
 * and timestamp columns take ISO or relative ("-10m") times. On any failure the
 * rows already inserted are removed before the error is rethrown.
 */
export async function insertFixtures(rows: FixtureRow[], scope: Pick<StateScope, 'userId' | 'workspaceId'>,
  at: Date = new Date()): Promise<InsertedFixtures> {
  const { getDb } = await import('@/db/postgres');
  const inserted: InsertedFixtures = { refs: {}, created: [] };
  try {
    for (const [index, row] of rows.entries()) {
      const { table, defaults } = entry(row.table);
      const cols = columns(table);
      const values: Record<string, unknown> = { ...(defaults?.() ?? {}) };
      if (cols.userId) values.userId = scope.userId;
      if (cols.workspaceId && scope.workspaceId) values.workspaceId = scope.workspaceId;
      // Before `at` (the database clock read before setup), so a fixture never
      // counts as the turn's under `since: test`.
      if (cols.createdAt) values.createdAt = new Date(at.getTime() - 1000);
      const refs = scopeRefs({ ...scope, refs: inserted.refs });
      for (const [name, raw] of Object.entries(row.values ?? {})) {
        const { key, col } = column(table, name);
        const value = resolveRef(raw, refs);
        values[key] = col.dataType === 'date' ? toDate(value) : value;
      }
      if (cols.userId && values.userId !== scope.userId)
        throw new StateSetupError(`stateSetup[${index}] (${row.table}): fixtures belong to the eval user; do not set user_id.`);
      const pk = cols.id ? 'id' : 'seq';
      let created: Record<string, unknown> | undefined;
      try {
        [created] = await getDb().insert(table).values(values as never).returning() as Record<string, unknown>[];
      } catch (err) {
        const hint = cols.workspaceId && !scope.workspaceId ? ' (Companion rows need context.workspaceId)' : '';
        throw new StateSetupError(`stateSetup[${index}] (${row.table}) could not be inserted${hint}: ${(err as Error).message}`);
      }
      const id = String(created?.[pk]);
      inserted.created.push({ table: row.table, id });
      if (row.as) inserted.refs[row.as] = id;
    }
  } catch (err) {
    await removeFixtures(inserted).catch((cleanupErr: unknown) =>
      console.warn(`Fixture rollback incomplete: ${(cleanupErr as Error).message}`));
    throw err;
  }
  return inserted;
}

/**
 * Delete fixture rows, newest first. A row already gone (a cascade from its
 * parent) is fine; any other failure is collected and thrown once at the end,
 * after every row has been tried.
 */
export async function removeFixtures(inserted: InsertedFixtures): Promise<void> {
  const { getDb } = await import('@/db/postgres');
  const errors: string[] = [];
  for (const { table: name, id } of [...inserted.created].reverse()) {
    const { table } = entry(name);
    const cols = columns(table);
    const pk = cols.id ?? cols.seq;
    try {
      await getDb().delete(table).where(eq(pk, cols.id ? id : Number(id)));
    } catch (err) {
      errors.push(`${name}/${id}: ${(err as Error).message}`);
    }
  }
  if (errors.length) throw new Error(`Could not remove fixture rows: ${errors.join('; ')}`);
}

/**
 * Delete the eval user's rows in `tables` created since the test began — the
 * memories a failing poisoning case extracted, the notifications a turn sent.
 * Only for tables scoped directly by user, and only rows since `since`.
 */
export async function cleanupCreated(tables: string[], scope: StateScope): Promise<void> {
  const { getDb } = await import('@/db/postgres');
  for (const name of tables) {
    const { table, scope: rule } = entry(name);
    const cols = columns(table);
    if (rule !== 'user' && rule !== 'user_workspace') throw new StateSetupError(`cleanup: "${name}" is not a per-user table.`);
    if (!cols.createdAt) throw new StateSetupError(`cleanup: "${name}" has no created_at.`);
    await getDb().delete(table).where(and(scoped(name, scope), gte(cols.createdAt, scope.since)));
  }
}

/** The database's clock: `since` must compare with created_at defaults on the same clock. */
export async function dbNow(): Promise<Date> {
  const { queryRaw } = await import('@/db/postgres');
  const { rows } = await queryRaw('SELECT clock_timestamp() AS now');
  return new Date(rows[0].now as string | Date);
}

/**
 * Wait until post-turn work for the eval user has gone quiet: no new model
 * calls for memory extraction or embedding (`cost_log`) and no new memories
 * for `quietMs`, after at least `minMs`. The backend runs extraction
 * fire-and-forget with no pending marker this process can read, so activity
 * is the signal. Throws StateSetupError when it is still busy at `timeoutMs`,
 * rather than grading a half-finished state.
 */
export async function waitForQuiet(scope: Pick<StateScope, 'userId' | 'since'>, opts: { minMs?: number; quietMs?: number; timeoutMs: number }): Promise<void> {
  const { queryRaw } = await import('@/db/postgres');
  const start = Date.now();
  const quietMs = opts.quietMs ?? 5000;
  const signature = async () => {
    const { rows } = await queryRaw(
      `SELECT (SELECT count(*) FROM cost_log WHERE user_id = $1 AND created_at >= $2 AND request_type IN ('memory_extraction', 'embedding'))
            + (SELECT count(*) FROM memories WHERE user_id = $1 AND (created_at >= $2 OR updated_at >= $2)) AS n`,
      [scope.userId, scope.since.toISOString()]);
    return String(rows[0].n);
  };
  let last = await signature();
  let lastChange = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    await new Promise((ok) => setTimeout(ok, 1000));
    const now = await signature();
    if (now !== last) { last = now; lastChange = Date.now(); }
    if (Date.now() - start >= (opts.minMs ?? 0) && Date.now() - lastChange >= quietMs) return;
  }
  throw new StateSetupError(`Post-turn work (memory extraction) was still running after ${Math.round(opts.timeoutMs / 1000)}s; the end state was not graded.`);
}

/** Validate a query's shape at load time: table and columns exist. */
export function validateStateQuery(query: StateQuery): void {
  const { table } = entry(query.table);
  for (const name of [...Object.keys(query.where ?? {}), ...Object.keys(query.matches ?? {})]) column(table, name.split('.')[0]);
  expectationMet(query, 0);
}

/** Validate fixture rows at load time. */
export function validateFixtures(rows: FixtureRow[]): void {
  for (const row of rows) {
    const { table } = entry(row.table);
    for (const name of Object.keys(row.values ?? {})) column(table, name);
  }
}
