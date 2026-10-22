/**
 * Which context hooks a user has: the built-ins (on unless the user switched
 * them off) and the ones the user added. A built-in has no row until the user
 * changes it; deleting that row puts the default back.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { type ContextHookRow, contextHooks } from '@/db/schema/context-hooks';
import { parseKindConfig } from './kinds';
import { CONTEXT_HOOK_EVENTS, CONTEXT_HOOK_KINDS, type ContextHookDefinition, type ContextHookEvent, type ContextHookKind } from './types';

export const BUILTIN_HOOKS: ReadonlyArray<Omit<ContextHookDefinition, 'id'> & { builtin: string; description: string }> = [
  {
    builtin: 'knowledge-recall',
    name: 'Knowledge recall',
    description: 'Searches your knowledge base and notes with each message and shows the agent the closest passages. Shows nothing when no passage is close enough.',
    kind: 'recall',
    events: ['turn_start', 'worker_start'],
    config: {},
    enabled: true,
  },
  {
    builtin: 'notes-index',
    name: 'Notes index',
    description: 'Tells the agent which notes you have (pinned first, then recently changed), so it knows what to look up.',
    kind: 'notes_index',
    events: ['turn_start'],
    config: {},
    enabled: true,
  },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Most hooks a user may add, beside the built-ins. */
export const MAX_USER_HOOKS = 20;

function fromRow(row: ContextHookRow): ContextHookDefinition {
  return {
    id: row.id,
    builtin: row.builtin,
    name: row.name,
    kind: row.kind as ContextHookKind,
    events: row.events.filter((e): e is ContextHookEvent => (CONTEXT_HOOK_EVENTS as string[]).includes(e)),
    config: row.config ?? {},
    enabled: row.enabled,
  };
}

/** Every hook of the user, built-ins first, each built-in as the user left it. */
export async function listContextHooks(userId: string): Promise<ContextHookDefinition[]> {
  const rows = await getDb().select().from(contextHooks).where(eq(contextHooks.userId, userId)).orderBy(asc(contextHooks.createdAt));
  const changed = new Map(rows.filter((r) => r.builtin).map((r) => [r.builtin as string, r]));
  const builtins = BUILTIN_HOOKS.map((b): ContextHookDefinition => {
    const row = changed.get(b.builtin);
    if (row) return { ...fromRow(row), id: `builtin:${b.builtin}`, kind: b.kind };
    const { description: _description, ...rest } = b;
    return { ...rest, id: `builtin:${b.builtin}` };
  });
  return [...builtins, ...rows.filter((r) => !r.builtin && (CONTEXT_HOOK_KINDS as string[]).includes(r.kind)).map(fromRow)];
}

export interface ContextHookInputBody {
  name?: string;
  kind?: string;
  events?: string[];
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export class ContextHookError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
  }
}

function validEvents(events: string[] | undefined, fallback: ContextHookEvent[]): ContextHookEvent[] {
  if (events === undefined) return fallback;
  const out = [...new Set(events)].filter((e): e is ContextHookEvent => (CONTEXT_HOOK_EVENTS as string[]).includes(e));
  if (out.length !== new Set(events).size) throw new ContextHookError(`events must be among ${CONTEXT_HOOK_EVENTS.join(', ')}`);
  return out;
}

function validConfig(kind: ContextHookKind, config: Record<string, unknown> | undefined): Record<string, unknown> {
  const parsed = parseKindConfig(kind, config ?? {});
  if (!parsed.ok) throw new ContextHookError(parsed.error);
  // Store what the user set, not the filled-in defaults: a later default change reaches them.
  return config ?? {};
}

/** Change a built-in (`builtin:<key>`) or one of the user's hooks; returns the hook as saved. */
export async function updateContextHook(userId: string, id: string, body: ContextHookInputBody): Promise<ContextHookDefinition> {
  const db = getDb();
  if (id.startsWith('builtin:')) {
    const key = id.slice('builtin:'.length);
    const builtin = BUILTIN_HOOKS.find((b) => b.builtin === key);
    if (!builtin) throw new ContextHookError('No such built-in hook', 404);
    if (body.kind !== undefined && body.kind !== builtin.kind) throw new ContextHookError('A built-in hook keeps its kind');
    const current = (await listContextHooks(userId)).find((h) => h.builtin === key) as ContextHookDefinition;
    const values = {
      name: body.name?.trim() || current.name,
      kind: builtin.kind,
      events: validEvents(body.events, current.events),
      config: body.config !== undefined ? validConfig(builtin.kind, body.config) : current.config,
      enabled: body.enabled ?? current.enabled,
      updatedAt: new Date(),
    };
    const [row] = await db.insert(contextHooks).values({ userId, builtin: key, ...values })
      .onConflictDoUpdate({ target: [contextHooks.userId, contextHooks.builtin], set: values })
      .returning();
    return { ...fromRow(row), id, kind: builtin.kind };
  }
  if (!UUID.test(id)) throw new ContextHookError('No such hook', 404);
  const [existing] = await db.select().from(contextHooks).where(and(eq(contextHooks.id, id), eq(contextHooks.userId, userId), isNull(contextHooks.builtin))).limit(1);
  if (!existing) throw new ContextHookError('No such hook', 404);
  const kind = existing.kind as ContextHookKind;
  if (body.kind !== undefined && body.kind !== kind) throw new ContextHookError('A hook keeps its kind; add a new one instead');
  const [row] = await db.update(contextHooks).set({
    ...(body.name !== undefined ? { name: requireName(body.name) } : {}),
    ...(body.events !== undefined ? { events: validEvents(body.events, []) } : {}),
    ...(body.config !== undefined ? { config: validConfig(kind, body.config) } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    updatedAt: new Date(),
  }).where(and(eq(contextHooks.id, id), eq(contextHooks.userId, userId))).returning();
  return fromRow(row);
}

function requireName(name: string | undefined): string {
  const trimmed = name?.trim() ?? '';
  if (!trimmed) throw new ContextHookError('A hook needs a name');
  return trimmed.slice(0, 120);
}

export async function createContextHook(userId: string, body: ContextHookInputBody): Promise<ContextHookDefinition> {
  const kind = body.kind as ContextHookKind;
  if (!(CONTEXT_HOOK_KINDS as string[]).includes(body.kind ?? '')) throw new ContextHookError(`kind must be one of ${CONTEXT_HOOK_KINDS.join(', ')}`);
  const events = validEvents(body.events, ['turn_start']);
  const db = getDb();
  const own = await db.select({ id: contextHooks.id }).from(contextHooks).where(and(eq(contextHooks.userId, userId), isNull(contextHooks.builtin)));
  if (own.length >= MAX_USER_HOOKS) throw new ContextHookError(`At most ${MAX_USER_HOOKS} hooks of your own`, 409);
  const [row] = await db.insert(contextHooks).values({
    userId, builtin: null, name: requireName(body.name), kind, events,
    config: validConfig(kind, body.config), enabled: body.enabled ?? true,
  }).returning();
  return fromRow(row);
}

/** Delete one of the user's hooks, or put a built-in back to its default. */
export async function deleteContextHook(userId: string, id: string): Promise<boolean> {
  const db = getDb();
  if (id.startsWith('builtin:')) {
    const key = id.slice('builtin:'.length);
    if (!BUILTIN_HOOKS.some((b) => b.builtin === key)) return false;
    await db.delete(contextHooks).where(and(eq(contextHooks.userId, userId), eq(contextHooks.builtin, key)));
    return true;
  }
  if (!UUID.test(id)) return false;
  const gone = await db.delete(contextHooks).where(and(eq(contextHooks.id, id), eq(contextHooks.userId, userId))).returning({ id: contextHooks.id });
  return gone.length > 0;
}
