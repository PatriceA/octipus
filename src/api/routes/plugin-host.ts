/**
 * The host API of plugin packages (docs/PLUGIN-PACKAGES.md#host-api):
 * `/api/plugin-host/*`, a narrow surface a package's tool calls back into
 * while it runs, as the user who triggered the call.
 *
 * Only the per-call token of src/plugins/packages/host-api.ts is accepted
 * (`Authorization: Bearer ocph_…`), and only with the package's name stamped
 * by its egress proxy (`x-octipus-plugin-egress`): the token is bound to that
 * package, to the user and workspace of the call, to its scopes and to the
 * call's lifetime. A session cookie or API token gives nothing here, and the
 * token gives nothing anywhere else. Every request is audited
 * (`resource_type = plugin_host`), allowed or refused.
 *
 * The user's data scope applies as for the user's own agent: the content
 * repositories of the workspace the call ran in (`contentRepos`), re-resolved
 * for each request so a membership removed or a role lowered meanwhile bites;
 * documents above the package's `maxProtection` are refused, and what is
 * read raises the calling session's protection level.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import { checkRateLimit } from '@/core/artifacts/rate-limit';
import { NoteExistsError, getNoteService } from '@/core/knowledge/notes';
import { loadSessionLevel, raiseSessionLevel, sessionProtectionLevel } from '@/core/protection/session-level';
import { auditTaskMutation } from '@/core/tasks/audit';
import { observeTaskProvenance, taskProvenance } from '@/core/tasks/provenance';
import { getDb } from '@/db/postgres';
import { auditRepository } from '@/db/repositories/audit-repository';
import { contentRepos } from '@/db/repositories/content';
import { users } from '@/db/schema/users';
import { type HostTokenGrant, noteHostRead, verifyHostToken } from '@/plugins/packages/host-api';
import { readLevelOf } from '@/plugins/packages/read-level';
import { STORE_AUDIT_WINDOW_MS, storeAuditAggregator } from '@/plugins/packages/store-audit';
import { storeDelete, storeGet, storeKeyFromPath, storeList, storePut, type StoreOutcome, storeWriteLimit } from '@/plugins/packages/store';
import type { StoreScope } from '@/db/repositories/plugin-store-repository';
import { clientIp } from '@/security/client-ip';
import { egressStampValid, HOST_API_EGRESS_HEADER, HOST_API_EGRESS_KEY_HEADER } from '@/security/egress-proxy';
import type { Principal } from '@/security/principal';
import { SpaceError, spaceErrorStatus } from '@/security/space-access';
import type { PluginHostScope } from '@/shared/plugin-package';
import { effectiveProtectionLevel } from '@/shared/protection';
import { apiLogger } from '@/utils/logger';

type Set = { status?: number | string; headers: Record<string, string> };
interface HostCtx { request: Request; set: Set; socketAddress?: string }

interface Authorized {
  grant: HostTokenGrant;
  principal: Principal;
}

/** One audit row per request. */
async function audit(grant: Pick<HostTokenGrant, 'userId' | 'plugin' | 'tool'> | null, plugin: string, op: string, status: number, details: Record<string, unknown> = {}): Promise<void> {
  try {
    await auditRepository.log({
      userId: grant?.userId ?? null,
      action: status < 400 ? 'tool_executed' : 'permission_denied',
      resourceType: 'plugin_host',
      resourceId: plugin || 'unknown',
      details: { op, status, ...(grant ? { tool: grant.tool } : {}), ...details },
    });
  } catch (err) {
    apiLogger.error({ err, plugin, op }, 'plugin-host: audit row could not be written');
  }
}

/** The principal of the call: the user as their own agent sees them, in the workspace the call ran in (re-resolved now). */
async function principalOf(grant: HostTokenGrant): Promise<Principal | null> {
  const [user] = await getDb().select({ id: users.id, username: users.username, isActive: users.isActive, kind: users.kind })
    .from(users).where(and(eq(users.id, grant.userId))).limit(1);
  if (!user?.isActive || user.kind !== 'local') return null;
  const base: Principal = { kind: 'user', userId: user.id, username: user.username, isAdmin: false, sessionToken: null, roles: ['user'] };
  const { resolveWorkspace } = await import('@/security/workspace-resolver');
  const resolution = await resolveWorkspace(base, grant.workspaceId);
  if (resolution.denied || resolution.workspaceId === null) return null;
  if (resolution.workspaceKind === 'shared') {
    return {
      ...base, workspaceId: resolution.workspaceId, workspaceKind: 'shared',
      spaceRole: resolution.spaceRole, spaceScope: resolution.spaceScope ?? null, spaceArchived: resolution.spaceArchived ?? false,
    };
  }
  return { ...base, workspaceId: resolution.workspaceId, workspaceKind: 'personal' };
}

/** Refusals without a token, counted per (code, package) and written as one row per minute. */
const refusals = new Map<string, { count: number; since: number }>();
const REFUSAL_WINDOW_MS = 60_000;

async function auditRefusalAggregate(code: string, plugin: string, now = Date.now()): Promise<void> {
  const key = `${code}\n${plugin}`;
  const entry = refusals.get(key);
  if (entry && now - entry.since < REFUSAL_WINDOW_MS) {
    entry.count += 1;
    return;
  }
  // A new window: one row for this refusal and those counted since the last row, then count afresh.
  const count = 1 + (entry?.count ?? 0);
  refusals.set(key, { count: 0, since: now });
  if (refusals.size > 1000) refusals.clear();
  await audit(null, plugin, 'refused', 401, { code, count, windowMs: REFUSAL_WINDOW_MS });
}

/** Test-only. */
export function _resetHostRefusals(): void {
  refusals.clear();
}

/**
 * The token's grant and the principal it acts as, or the refusal (written
 * to `set`, audited). `scope` is what the endpoint needs; null for one that
 * only describes the token.
 */
async function authorize(ctx: HostCtx, op: string, scope: PluginHostScope | null): Promise<Authorized | { error: string; code: string }> {
  const plugin = ctx.request.headers.get(HOST_API_EGRESS_HEADER) ?? '';
  const auth = ctx.request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const refuse = async (status: number, error: string, code: string, grant: HostTokenGrant | null = null) => {
    ctx.set.status = status;
    await audit(grant, plugin, op, status, { code, ...(scope ? { scope } : {}) });
    return { error, code };
  };
  // Refused before any token is known: nobody to attribute it to. Limited per
  // address, and audited as one aggregate row per kind and minute, never per request.
  const refuseUnknown = async (error: string, code: 'not_via_proxy' | 'invalid_token') => {
    const ip = clientIp(ctx.request, ctx.socketAddress);
    const limited = checkRateLimit(`plugin-host-refused:${ip}`, { capacity: 20, refillPerSecond: 2 });
    ctx.set.status = limited.allowed ? 401 : 429;
    if (!limited.allowed) ctx.set.headers['retry-after'] = String(limited.retryAfterSeconds ?? 1);
    await auditRefusalAggregate(code, /^[a-z][a-z0-9-]{1,49}$/.test(plugin) ? plugin : 'unknown');
    return limited.allowed ? { error, code } : { error: 'Too many refused host API requests', code: 'rate_limited' };
  };
  // Through the package's egress proxy only: it names the package and proves it with that proxy's own secret.
  if (!plugin || !/^[a-z][a-z0-9-]{1,49}$/.test(plugin) || !egressStampValid(plugin, ctx.request.headers.get(HOST_API_EGRESS_KEY_HEADER))) {
    return refuseUnknown('The host API is reached through the package\'s egress proxy', 'not_via_proxy');
  }
  const grant = token ? verifyHostToken(token, plugin) : null;
  if (!grant) return refuseUnknown('A valid host API token for this package is required', 'invalid_token');
  const limited = checkRateLimit(`plugin-host:${grant.plugin}:${grant.userId}`, { capacity: 60, refillPerSecond: 10 });
  if (!limited.allowed) {
    ctx.set.headers['retry-after'] = String(limited.retryAfterSeconds ?? 1);
    return refuse(429, 'Too many host API requests', 'rate_limited', grant);
  }
  if (scope && !grant.scopes.includes(scope)) return refuse(403, `This call's token does not carry the scope ${scope}`, 'scope_missing', grant);
  const principal = await principalOf(grant);
  if (!principal) return refuse(403, 'The user or workspace of this call is no longer available', 'principal_gone', grant);
  // The level the call works at: what it read so far, what the package has
  // read for this user in any call (src/plugins/packages/read-level.ts), and
  // what the calling session holds. A tool runs inside a conversation that
  // may hold content above level 1; whatever it writes may carry that.
  const kept = await readLevelOf(grant.plugin, grant.userId);
  grant.readLevel = Math.max(grant.readLevel ?? 1, kept, await sessionLevelOf(grant.sessionId));
  return { grant, principal };
}

/** The calling session's level, loaded from its row once per process; a level that cannot be loaded counts as 4. */
async function sessionLevelOf(sessionId: string | null): Promise<number> {
  if (!sessionId) return 1;
  try {
    await loadSessionLevel(sessionId);
  } catch (err) {
    apiLogger.warn({ err, sessionId }, 'plugin-host: the session level could not be loaded; counted as 4');
    return 4;
  }
  return sessionProtectionLevel(sessionId);
}

/**
 * Notes and tasks have no protection level: a call working above level 1
 * (the package has read content above it for this user, or the calling
 * session holds such content) may not write there, or it could carry that
 * content down to level 1. The refusal, or null.
 */
function launderingRefusal(ctx: HostCtx, grant: HostTokenGrant, what: string): { error: string; code: string } | null {
  const level = grant.readLevel ?? 1;
  if (level <= 1) return null;
  ctx.set.status = 403;
  return {
    error: `This call works at protection level ${level} (what the package has read for this user, or what the calling session holds); ${what} have no protection level, so it may not write them (it may write a document, stored at level ${level} or higher)`,
    code: 'read_level',
  };
}

/**
 * Store requests audited in aggregate (src/plugins/packages/store-audit.ts):
 * one row per package, user, op, status and code per minute, carrying the
 * requests counted since the previous row. Refusals before the token is
 * accepted, and failures, keep their own rows.
 */
const storeAudit = storeAuditAggregator();

async function auditStoreAggregate(grant: HostTokenGrant, op: string, status: number, details: Record<string, unknown>): Promise<void> {
  const kind = [grant.plugin, grant.userId, op, status, String(details.code ?? '')].join('\n');
  await storeAudit.count(kind, (count) => audit(grant, grant.plugin, op, status, { ...details, count, windowMs: STORE_AUDIT_WINDOW_MS, aggregated: true }));
}

/** Test-only. */
export function _resetStoreAudit(): void {
  storeAudit.reset();
}

/** Run an endpoint body: audit the outcome (in aggregate with `aggregate`), map a space refusal to its status. */
async function run<T>(
  ctx: HostCtx, op: string, scope: PluginHostScope | null,
  body: (a: Authorized, details: Record<string, unknown>) => Promise<T>,
  opts: { aggregate?: boolean } = {},
): Promise<T | { error: string; code?: string }> {
  const a = await authorize(ctx, op, scope);
  if ('error' in a) return a;
  // What the endpoint adds to its audit row (a URL's host and hash, a refusal code).
  const details: Record<string, unknown> = {};
  try {
    const out = await body(a, details);
    const status = typeof ctx.set.status === 'number' ? ctx.set.status : 200;
    if (opts.aggregate) await auditStoreAggregate(a.grant, op, status, { ...(scope ? { scope } : {}), ...details });
    else await audit(a.grant, a.grant.plugin, op, status, { ...(scope ? { scope } : {}), ...details });
    return out;
  } catch (err) {
    if (err instanceof SpaceError) {
      const status = spaceErrorStatus(err);
      ctx.set.status = status;
      await audit(a.grant, a.grant.plugin, op, status, { scope, code: err.code, ...details });
      return { error: err.message, code: err.code };
    }
    apiLogger.error({ err, plugin: a.grant.plugin, op }, 'plugin-host: request failed');
    ctx.set.status = 500;
    await audit(a.grant, a.grant.plugin, op, 500, { scope, ...details });
    return { error: 'The host API request failed' };
  }
}

/**
 * A `web:read` URL as the audit records it: its host and a sha256 of the
 * whole URL, never the URL (its path and query can carry what the package read).
 */
export function webReadAuditOf(url: string): { host: string; urlSha256: string } {
  let host = '';
  try { host = new URL(url).host; } catch { host = ''; }
  return { host, urlSha256: createHash('sha256').update(url).digest('hex') };
}

/** `web:read`: the article text handed back at most (the rest is cut, `truncated`). */
const WEB_READ_MAX_CHARS = 100_000;
/** `web:read`: cleaned HTML longer than this is left out (`contentHtml: ''`, `truncated`). */
const WEB_READ_MAX_HTML = 400_000;

/** Where a store key starts in a host API path. */
const STORE_MARKER = '/plugin-host/store/';

/** A store refusal: its status (and a version conflict's current version), its code in the audit details. */
function storeRefusal(ctx: HostCtx, outcome: Extract<StoreOutcome<unknown>, { ok: false }>, details: Record<string, unknown>): { error: string; code: string; current?: number } {
  ctx.set.status = outcome.status;
  details.code = outcome.code;
  return { error: outcome.error, code: outcome.code, ...(outcome.current !== undefined ? { current: outcome.current } : {}) };
}

/** Store writes and deletes: at most 30 in a burst per package and user, 5 a second after that (on top of the host API's own limit; the page's writes share the bucket). */
function storeWriteLimited(ctx: HostCtx, grant: HostTokenGrant, details: Record<string, unknown>): { error: string; code: string } | null {
  const limited = storeWriteLimit(grant.plugin, grant.userId);
  if (limited.allowed) return null;
  ctx.set.status = 429;
  ctx.set.headers['retry-after'] = String(limited.retryAfterSeconds ?? 1);
  details.code = 'rate_limited';
  return { error: 'Too many store writes', code: 'rate_limited' };
}

/** Whose store a call reaches: its package, its user, and the shared space it ran in (null: the user's personal workspace). */
function storeScopeOf(grant: HostTokenGrant, principal: Principal): StoreScope {
  return { pkg: grant.plugin, userId: grant.userId, workspaceId: principal.workspaceKind === 'shared' ? principal.workspaceId ?? null : null };
}

/** What a store read handed over raises the call (and the calling session, and the package's level for this user) to. */
async function noteStoreRead(grant: HostTokenGrant, level: number): Promise<void> {
  if (level <= 1) return;
  if (grant.sessionId) raiseSessionLevel(grant.sessionId, level);
  await noteHostRead(grant, level);
}

/** A host module's outcome as the answer: the value, or the refusal (its status, its code in the audit details). */
function outcomeOf<T>(ctx: HostCtx, details: Record<string, unknown>, out: { ok: true; value: T } | { ok: false; status: number; code: string; error: string }): T | { error: string; code: string } {
  if (out.ok) return out.value;
  ctx.set.status = out.status;
  details.code = out.code;
  return { error: out.error, code: out.code };
}

const mailSource = t.Union([t.Literal('mail'), t.Literal('inbox')]);
/** "a@x.de, Jane <j@y.de>" or a list of addresses. */
const recipients = t.Union([t.String({ maxLength: 10_000 }), t.Array(t.String({ maxLength: 400 }), { maxItems: 50 })]);
const mailCompose = t.Object({
  source: mailSource,
  accountId: t.Optional(t.String({ maxLength: 64 })),
  to: t.Optional(recipients),
  cc: t.Optional(recipients),
  subject: t.Optional(t.String({ maxLength: 500 })),
  body: t.String({ minLength: 1, maxLength: 100_000 }),
  replyTo: t.Optional(t.String({ minLength: 1, maxLength: 1024 })),
  replyAll: t.Optional(t.Boolean()),
});
const calendarEvent = t.Object({
  provider: t.Union([t.Literal('google'), t.Literal('microsoft')]),
  title: t.String({ minLength: 1, maxLength: 500 }),
  start: t.String({ maxLength: 40 }),
  end: t.String({ maxLength: 40 }),
  allDay: t.Boolean(),
  location: t.Optional(t.String({ maxLength: 2000 })),
  description: t.Optional(t.String({ maxLength: 20_000 })),
});

const noteView = (n: { id: string; slug: string; title: string; body: string; tags?: unknown; noteKind?: unknown; updatedAt: Date }) => ({
  id: n.id, slug: n.slug, title: n.title, body: n.body, tags: n.tags ?? [], kind: n.noteKind ?? 'note', updatedAt: n.updatedAt,
});

export const pluginHostRoutes = new Elysia({ prefix: '/plugin-host' })
  .use(apiContext)

  // What this call's token may do.
  .get('/whoami', (ctx) => run(ctx, 'whoami', null, async ({ grant, principal }) => ({
    plugin: grant.plugin, tool: grant.tool, scopes: grant.scopes,
    workspace: principal.workspaceKind === 'shared' ? 'space' : 'personal',
    expiresAt: new Date(grant.expiresAt).toISOString(),
  })), { detail: { tags: ['plugin-host'] } })

  // The user's notes in the call's workspace (newest first), bodies included.
  .get('/notes', (ctx) => run(ctx, 'notes.list', 'notes:read', async ({ principal }) => {
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(ctx.query.limit ?? '50'), 10) || 50));
    const notes = await contentRepos(principal).notes.list({ tag: ctx.query.tag, limit });
    return { notes: notes.map(noteView) };
  }), {
    query: t.Object({ limit: t.Optional(t.String()), tag: t.Optional(t.String({ maxLength: 100 })) }),
    detail: { tags: ['plugin-host'] },
  })

  // Create a note. Never overwrites: a note at the same slug is a 409.
  .post('/notes', (ctx) => run(ctx, 'notes.create', 'notes:write', async ({ grant, principal }, details) => {
    const refusal = launderingRefusal(ctx, grant, 'notes');
    if (refusal) {
      details.code = refusal.code;
      return refusal;
    }
    try {
      const result = await getNoteService().save({
        scope: contentRepos(principal).noteScope,
        title: ctx.body.title,
        body: ctx.body.body ?? '',
        tags: ctx.body.tags,
        frontmatter: { source: `plugin:${grant.plugin}` },
        createOnly: true,
      });
      return { id: result.note.id, slug: result.note.slug };
    } catch (err) {
      if (err instanceof NoteExistsError) {
        ctx.set.status = 409;
        return { error: 'A note with this title already exists', code: 'exists' };
      }
      throw err;
    }
  }), {
    body: t.Object({
      title: t.String({ minLength: 1, maxLength: 300 }),
      body: t.Optional(t.String({ maxLength: 200_000 })),
      tags: t.Optional(t.Array(t.String({ maxLength: 100 }), { maxItems: 20 })),
    }),
    detail: { tags: ['plugin-host'] },
  })

  // The user's own tasks in the call's workspace.
  // Each task carries the provenance of the conversation it came from
  // (core/tasks/provenance.ts): one above the package's maxProtection is left
  // out, and what is handed over raises the calling session as the tasks tool does.
  .get('/tasks', (ctx) => run(ctx, 'tasks.list', 'tasks:read', async ({ grant, principal }) => {
    const status = ctx.query.status;
    const all = (await contentRepos(principal).tasks.listOwn(status ? { status } : {})).slice(0, 200);
    const provenance = await Promise.all(all.map((task) => taskProvenance(grant.userId, [task])));
    const tasks = all.filter((_task, i) => provenance[i].protectionLevel <= grant.maxProtection);
    const kept = provenance.filter((p) => p.protectionLevel <= grant.maxProtection);
    for (const p of kept) await noteHostRead(grant, p.protectionLevel);
    if (grant.sessionId && kept.length > 0) {
      observeTaskProvenance(grant.sessionId, {
        protectionLevel: Math.max(...kept.map((p) => p.protectionLevel)),
        flowLabel: Object.assign({}, ...kept.map((p) => p.flowLabel)),
      });
    }
    return {
      withheld: all.length - tasks.length,
      tasks: tasks.map((x) => ({
        id: x.id, title: x.title, notes: x.notes, status: x.status, priority: x.priority, category: x.category, dueAt: x.dueAt, createdAt: x.createdAt,
      })),
    };
  }), {
    query: t.Object({ status: t.Optional(t.Union(['open', 'in_progress', 'done', 'archived'].map((s) => t.Literal(s)))) }),
    detail: { tags: ['plugin-host'] },
  })

  // Create a task for the user.
  .post('/tasks', (ctx) => run(ctx, 'tasks.create', 'tasks:write', async ({ grant, principal }, details) => {
    const refusal = launderingRefusal(ctx, grant, 'tasks');
    if (refusal) {
      details.code = refusal.code;
      return refusal;
    }
    const dueAt = ctx.body.dueAt ? new Date(ctx.body.dueAt) : null;
    if (dueAt && Number.isNaN(dueAt.getTime())) {
      ctx.set.status = 400;
      return { error: 'dueAt is not a date', code: 'invalid' };
    }
    const link = ctx.body.link;
    if (link && !/^https?:\/\//i.test(link.url)) {
      ctx.set.status = 400;
      return { error: 'link.url is an http(s) URL', code: 'invalid' };
    }
    const task = await contentRepos(principal).tasks.create({
      title: ctx.body.title,
      notes: ctx.body.notes ?? null,
      priority: ctx.body.priority ?? 0,
      dueAt,
      ...(ctx.body.category ? { category: ctx.body.category } : {}),
      source: 'agent',
      sourceRef: { plugin: grant.plugin, tool: grant.tool, ...(link ? { url: link.url, ...(link.label ? { label: link.label } : {}) } : {}) } as never,
    });
    await auditTaskMutation({
      userId: task.userId, taskId: task.id, op: 'create', change: ['title', 'notes', 'priority', 'dueAt', ...(ctx.body.category ? ['category'] : [])],
      actor: { kind: 'system', id: `plugin:${grant.plugin}` }, runId: grant.sessionId,
    });
    return { id: task.id, title: task.title, status: task.status };
  }), {
    body: t.Object({
      title: t.String({ minLength: 1, maxLength: 500 }),
      notes: t.Optional(t.String({ maxLength: 10_000 })),
      priority: t.Optional(t.Integer({ minimum: 0, maximum: 3 })),
      dueAt: t.Optional(t.String({ maxLength: 40 })),
      /** A user list to file it under (e.g. "Reading"). */
      category: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
      /** Where it came from: shown with the task and linked back to. */
      link: t.Optional(t.Object({ url: t.String({ minLength: 1, maxLength: 2048 }), label: t.Optional(t.String({ maxLength: 500 })) })),
    }),
    detail: { tags: ['plugin-host'] },
  })

  // One document of the call's workspace: its metadata and extracted text,
  // if its protection level is within the package's maxProtection.
  .get('/documents/:id', (ctx) => run(ctx, 'documents.read', 'documents:read', async ({ grant, principal }) => {
    const doc = await contentRepos(principal).documents.findInScope(ctx.params.id);
    if (!doc) {
      ctx.set.status = 404;
      return { error: 'Document not found', code: 'not_found' };
    }
    const level = effectiveProtectionLevel(doc.protectionLevel);
    if (level > grant.maxProtection) {
      ctx.set.status = 403;
      return { error: `The document is at protection level ${level}; this package may see up to ${grant.maxProtection}`, code: 'protection_level' };
    }
    // The text goes back into the calling conversation with the tool's result,
    // and whatever this call sends to a model afterwards carries its level.
    if (grant.sessionId) raiseSessionLevel(grant.sessionId, doc.protectionLevel);
    await noteHostRead(grant, level);
    return {
      id: doc.id, name: doc.originalName, mimeType: doc.mimeType, size: doc.size, category: doc.category,
      summary: doc.summary, text: doc.ocrText, protectionLevel: level, createdAt: doc.createdAt,
    };
  }), {
    params: t.Object({ id: t.String({ maxLength: 64 }) }),
    detail: { tags: ['plugin-host'] },
  })

  // Create a text document for the user in the call's workspace (src/plugins/packages/host-documents.ts):
  // the space's role rules apply, the row records the package and tool
  // (`metadata.sourceRef`), and its level is at least what the call has read.
  .post('/documents', (ctx) => run(ctx, 'documents.create', 'documents:write', async ({ grant, principal }, details) => {
    const { createPluginDocument } = await import('@/plugins/packages/host-documents');
    const outcome = await createPluginDocument(grant, contentRepos(principal), ctx.body);
    if (!outcome.ok) {
      ctx.set.status = outcome.status;
      details.code = outcome.code;
      return { error: outcome.error, code: outcome.code };
    }
    details.documentId = outcome.id;
    return { id: outcome.id, name: outcome.name, protectionLevel: outcome.protectionLevel, size: outcome.size };
  }), {
    body: t.Object({
      name: t.String({ minLength: 1, maxLength: 200 }),
      content: t.String({ minLength: 1, maxLength: 500_000 }),
      mimeType: t.Optional(t.Union([t.Literal('text/markdown'), t.Literal('text/plain')])),
      category: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
      summary: t.Optional(t.String({ maxLength: 2000 })),
      protectionLevel: t.Optional(t.Integer({ minimum: 1, maximum: 4 })),
    }),
    detail: { tags: ['plugin-host'] },
  })

  // Replace the content of a document this package created (and no other),
  // within its maxProtection, in the call's workspace.
  .put('/documents/:id', (ctx) => run(ctx, 'documents.update', 'documents:write', async ({ grant, principal }, details) => {
    details.documentId = ctx.params.id;
    const { updatePluginDocument } = await import('@/plugins/packages/host-documents');
    const outcome = await updatePluginDocument(grant, contentRepos(principal), ctx.params.id, ctx.body);
    if (!outcome.ok) {
      ctx.set.status = outcome.status;
      details.code = outcome.code;
      return { error: outcome.error, code: outcome.code };
    }
    return { id: outcome.id, name: outcome.name, protectionLevel: outcome.protectionLevel, size: outcome.size };
  }), {
    params: t.Object({ id: t.String({ maxLength: 64 }) }),
    body: t.Object({
      content: t.String({ minLength: 1, maxLength: 500_000 }),
      name: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
      summary: t.Optional(t.String({ maxLength: 2000 })),
    }),
    detail: { tags: ['plugin-host'] },
  })

  // Start a background agent run as the user (src/plugins/packages/host-agent.ts):
  // the host's own worker of the role, unattended, in a session of its own,
  // under the user's rules, budgets and protection routing. Answers its id at
  // once; a write or external tool only.
  .post('/agent/runs', (ctx) => run(ctx, 'agent.start', 'agent:run', async ({ grant, principal }, details) => {
    const { startPluginAgentRun } = await import('@/plugins/packages/host-agent');
    const outcome = await startPluginAgentRun(grant, principal, ctx.body);
    if (!outcome.ok) {
      ctx.set.status = outcome.status;
      if (outcome.retryAfter) ctx.set.headers['retry-after'] = String(outcome.retryAfter);
      details.code = outcome.code;
      return { error: outcome.error, code: outcome.code };
    }
    ctx.set.status = 202;
    details.runId = outcome.value.id;
    details.role = outcome.value.role;
    return outcome.value;
  }), {
    body: t.Object({
      prompt: t.String({ minLength: 1, maxLength: 20_000 }),
      role: t.Optional(t.String({ minLength: 1, maxLength: 50, pattern: '^[a-z][a-z0-9_-]*$' })),
      title: t.Optional(t.String({ maxLength: 200 })),
    }),
    detail: { tags: ['plugin-host'] },
  })

  // A run of this package for this user: its status and, once done, its final
  // text (withheld above the package's maxProtection).
  .get('/agent/runs/:id', (ctx) => run(ctx, 'agent.read', 'agent:run', async ({ grant }, details) => {
    details.runId = ctx.params.id;
    const { readPluginAgentRun } = await import('@/plugins/packages/host-agent');
    const outcome = await readPluginAgentRun(grant, ctx.params.id);
    if (!outcome.ok) {
      ctx.set.status = outcome.status;
      details.code = outcome.code;
      return { error: outcome.error, code: outcome.code };
    }
    return outcome.value;
  }), {
    params: t.Object({ id: t.String({ maxLength: 64 }) }),
    detail: { tags: ['plugin-host'] },
  })

  // Cancel a run of this package for this user: its worker stops and the run
  // reads as cancelled. Any tool of the package may cancel its own run (it
  // only ends work); another package's or user's run is not found.
  .delete('/agent/runs/:id', (ctx) => run(ctx, 'agent.cancel', 'agent:run', async ({ grant }, details) => {
    details.runId = ctx.params.id;
    const { cancelPluginAgentRun } = await import('@/plugins/packages/host-agent');
    const outcome = await cancelPluginAgentRun(grant, ctx.params.id);
    if (!outcome.ok) {
      ctx.set.status = outcome.status;
      details.code = outcome.code;
      return { error: outcome.error, code: outcome.code };
    }
    return outcome.value;
  }), {
    params: t.Object({ id: t.String({ maxLength: 64 }) }),
    detail: { tags: ['plugin-host'] },
  })

  // One public web page, fetched by the host through its SSRF guard and turned
  // into a clean article (src/core/web-read): the package never touches
  // the network itself. Size and time are capped by the fetcher (5 MB, 15 s);
  // the text handed back is capped here.
  .post('/web/read', (ctx) => run(ctx, 'web.read', 'web:read', async ({ grant }, details) => {
    Object.assign(details, webReadAuditOf(ctx.body.url));
    const { fetchArticle, WebReadError } = await import('@/core/web-read/fetch');
    let doc: Awaited<ReturnType<typeof fetchArticle>>;
    try {
      doc = await fetchArticle(ctx.body.url);
    } catch (err) {
      // The package learns only that it was refused or failed, never why
      // (an address, a status, a size): no probing of what lies behind the guard.
      const code = err instanceof WebReadError && err.blocked ? 'blocked' : 'fetch_failed';
      apiLogger.info({ err: (err as Error).message, plugin: grant.plugin, ...details }, 'plugin-host: web:read refused or failed');
      details.code = code;
      ctx.set.status = 422;
      return code === 'blocked'
        ? { error: 'This address may not be fetched', code }
        : { error: 'The page could not be fetched', code };
    }
    const truncated = doc.textContent.length > WEB_READ_MAX_CHARS || doc.contentHtml.length > WEB_READ_MAX_HTML;
    return {
      ...doc,
      textContent: doc.textContent.slice(0, WEB_READ_MAX_CHARS),
      contentHtml: doc.contentHtml.length > WEB_READ_MAX_HTML ? '' : doc.contentHtml,
      truncated,
    };
  }), {
    body: t.Object({ url: t.String({ minLength: 1, maxLength: 2048, pattern: '^https?://' }) }),
    detail: { tags: ['plugin-host'] },
  })

  // One text completion on the calling user's `everyday` model (their own
  // binding first, then the install's). No tools, no history: a system text
  // and a prompt in, the model's text out. Input and output are capped. A CLI
  // lane is refused (409 cli_model) unless the package declares
  // model.trustedInput and an admin approved model:cli-tools; such a call's
  // audit row records the model and `cliTools: true`.
  .post('/model/complete', (ctx) => run(ctx, 'model.complete', 'model:complete', async ({ grant, principal }, details) => {
    const { pluginModelComplete } = await import('@/plugins/packages/host-model');
    const outcome = await pluginModelComplete(grant, principal, ctx.body, details);
    if (!outcome.ok) {
      ctx.set.status = outcome.status;
      if (outcome.retryAfter) ctx.set.headers['retry-after'] = String(outcome.retryAfter);
      details.code = outcome.code;
      return { error: outcome.error, code: outcome.code };
    }
    return { output: outcome.output, model: outcome.model };
  }), {
    body: t.Object({
      system: t.Optional(t.String({ maxLength: 4000 })),
      prompt: t.String({ minLength: 1, maxLength: 40_000 }),
      maxTokens: t.Optional(t.Integer({ minimum: 1, maximum: 4000 })),
      temperature: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
    }),
    detail: { tags: ['plugin-host'] },
  })

  // ── The store (docs/PLUGIN-PACKAGES.md#store): the package's own data for
  // the token's user, and for nobody else. Nothing here names a user: the
  // token's is the only one. Audited in aggregate.

  // The token's user's keys in the call's workspace, sorted, with size and version (no values).
  .get('/store', (ctx) => run(ctx, 'store.list', 'store:read', async ({ grant, principal }, details) => {
    const limit = ctx.query.limit === undefined ? undefined : Number.parseInt(String(ctx.query.limit), 10);
    const outcome = await storeList(storeScopeOf(grant, principal), { prefix: ctx.query.prefix, limit }, grant.maxProtection);
    if (!outcome.ok) return storeRefusal(ctx, outcome, details);
    // A key can carry data: what a list hands over raises the call like a value.
    await noteStoreRead(grant, outcome.value.protectionLevel);
    const { protectionLevel: _level, ...rest } = outcome.value;
    return rest;
  }, { aggregate: true }), {
    query: t.Object({ prefix: t.Optional(t.String({ maxLength: 200 })), limit: t.Optional(t.String({ maxLength: 5 })) }),
    detail: { tags: ['plugin-host'] },
  })

  // One entry of the token's user: its value and version. Reading it raises
  // the call's level to the level it was written at.
  .get('/store/*', (ctx) => run(ctx, 'store.get', 'store:read', async ({ grant, principal }, details) => {
    const outcome = await storeGet(storeScopeOf(grant, principal), storeKeyFromPath(ctx.request.url, STORE_MARKER), grant.maxProtection);
    if (!outcome.ok) return storeRefusal(ctx, outcome, details);
    await noteStoreRead(grant, outcome.value.protectionLevel);
    return { value: outcome.value.value, version: outcome.value.version };
  }, { aggregate: true }), { detail: { tags: ['plugin-host'] } })

  // Write one entry of the token's user, at the call's level (or the entry's,
  // if higher), within the package's quota per user; compare-and-set with
  // ifVersion (0: only if new). Whatever the answer says about an entry that
  // was there raises the call to its level, as a read would.
  .put('/store/*', (ctx) => run(ctx, 'store.put', 'store:write', async ({ grant, principal }, details) => {
    const limited = storeWriteLimited(ctx, grant, details);
    if (limited) return limited;
    const outcome = await storePut(storeScopeOf(grant, principal), storeKeyFromPath(ctx.request.url, STORE_MARKER),
      ctx.body as { value?: unknown; ifVersion?: number }, grant.readLevel ?? 1, grant.maxProtection);
    if (outcome.previousLevel !== null) await noteStoreRead(grant, outcome.previousLevel);
    if (!outcome.ok) return storeRefusal(ctx, outcome, details);
    return { version: outcome.value.version };
  }, { aggregate: true }), {
    body: t.Object({ value: t.Optional(t.Any()), ifVersion: t.Optional(t.Integer({ minimum: 0 })) }),
    detail: { tags: ['plugin-host'] },
  })

  // Delete one entry of the token's user; finding it raises the call to its level.
  .delete('/store/*', (ctx) => run(ctx, 'store.delete', 'store:write', async ({ grant, principal }, details) => {
    const limited = storeWriteLimited(ctx, grant, details);
    if (limited) return limited;
    const outcome = await storeDelete(storeScopeOf(grant, principal), storeKeyFromPath(ctx.request.url, STORE_MARKER), grant.maxProtection);
    if (outcome.previousLevel !== null) await noteStoreRead(grant, outcome.previousLevel);
    if (!outcome.ok) return storeRefusal(ctx, outcome, details);
    return outcome.value;
  }, { aggregate: true }), { detail: { tags: ['plugin-host'] } })

  // ── Mail and calendar (docs/PLUGIN-PACKAGES.md#mail-and-calendar,
  // src/plugins/packages/host-mail.ts and host-calendar.ts): the user's own,
  // at their protection levels; a package changes and sends only what it created.

  // The Mail module's mailboxes the call reaches, and the connected inbox.
  .get('/mail/accounts', (ctx) => run(ctx, 'mail.accounts', 'mail:read', async ({ grant, principal }, details) => {
    const { listMailSources } = await import('@/plugins/packages/host-mail');
    return outcomeOf(ctx, details, await listMailSources(grant, principal, contentRepos(principal)));
  }), { detail: { tags: ['plugin-host'] } })

  // Messages, newest first, without their text; above the package's maxProtection left out.
  .get('/mail/messages', (ctx) => run(ctx, 'mail.list', 'mail:read', async ({ grant, principal }, details) => {
    const { listMail } = await import('@/plugins/packages/host-mail');
    const limit = ctx.query.limit === undefined ? undefined : Number.parseInt(ctx.query.limit, 10) || undefined;
    return outcomeOf(ctx, details, await listMail(grant, principal, contentRepos(principal), {
      source: ctx.query.source ?? 'mail', accountId: ctx.query.accountId, status: ctx.query.status,
      unread: ctx.query.unread === 'true' ? true : undefined, q: ctx.query.q, limit, cursor: ctx.query.cursor,
    }));
  }), {
    query: t.Object({
      source: t.Optional(mailSource),
      accountId: t.Optional(t.String({ maxLength: 64 })),
      status: t.Optional(t.Union([t.Literal('received'), t.Literal('sent'), t.Literal('draft')])),
      unread: t.Optional(t.Union([t.Literal('true'), t.Literal('false')])),
      q: t.Optional(t.String({ maxLength: 200 })),
      limit: t.Optional(t.String({ maxLength: 4 })),
      cursor: t.Optional(t.String({ maxLength: 2048 })),
    }),
    detail: { tags: ['plugin-host'] },
  })

  // One message with its plain text.
  .get('/mail/messages/:id', (ctx) => run(ctx, 'mail.read', 'mail:read', async ({ grant, principal }, details) => {
    const { readMail } = await import('@/plugins/packages/host-mail');
    return outcomeOf(ctx, details, await readMail(grant, principal, contentRepos(principal), ctx.query.source ?? 'mail', ctx.params.id));
  }), {
    params: t.Object({ id: t.String({ minLength: 1, maxLength: 1024 }) }),
    query: t.Object({ source: t.Optional(mailSource) }),
    detail: { tags: ['plugin-host'] },
  })

  // Save a draft as the user (never sends). A write or external tool only.
  .post('/mail/drafts', (ctx) => run(ctx, 'mail.draft', 'mail:draft', async ({ grant, principal }, details) => {
    const { createMailDraft } = await import('@/plugins/packages/host-mail');
    const out = await createMailDraft(grant, principal, contentRepos(principal), ctx.body);
    if (out.ok) details.draftId = out.value.id;
    return outcomeOf(ctx, details, out);
  }), { body: mailCompose, detail: { tags: ['plugin-host'] } })

  // Change a Mail module draft this package created.
  .put('/mail/drafts/:id', (ctx) => run(ctx, 'mail.draft.update', 'mail:draft', async ({ grant, principal }, details) => {
    details.draftId = ctx.params.id;
    const { updateMailDraft } = await import('@/plugins/packages/host-mail');
    return outcomeOf(ctx, details, await updateMailDraft(grant, contentRepos(principal), ctx.params.id, ctx.body));
  }), {
    params: t.Object({ id: t.String({ maxLength: 64 }) }),
    body: t.Object({ to: t.Optional(recipients), cc: t.Optional(recipients), subject: t.Optional(t.String({ maxLength: 500 })), body: t.Optional(t.String({ maxLength: 100_000 })) }),
    detail: { tags: ['plugin-host'] },
  })

  // Send a Mail module draft this package created. An external tool only.
  .post('/mail/drafts/:id/send', (ctx) => run(ctx, 'mail.draft.send', 'mail:send', async ({ grant, principal }, details) => {
    details.draftId = ctx.params.id;
    const { sendMailDraft } = await import('@/plugins/packages/host-mail');
    return outcomeOf(ctx, details, await sendMailDraft(grant, contentRepos(principal), ctx.params.id));
  }), { params: t.Object({ id: t.String({ maxLength: 64 }) }), detail: { tags: ['plugin-host'] } })

  // Compose and send a message now. An external tool only.
  .post('/mail/send', (ctx) => run(ctx, 'mail.send', 'mail:send', async ({ grant, principal }, details) => {
    const { sendMail } = await import('@/plugins/packages/host-mail');
    const out = await sendMail(grant, principal, contentRepos(principal), ctx.body);
    if (out.ok) Object.assign(details, { source: out.value.source, ...(out.value.id ? { messageId: out.value.id } : {}) });
    return outcomeOf(ctx, details, out);
  }), { body: mailCompose, detail: { tags: ['plugin-host'] } })

  // Events of the connected calendars in a window (at most 93 days).
  .get('/calendar/events', (ctx) => run(ctx, 'calendar.list', 'calendar:read', async ({ grant, principal }, details) => {
    const { listPluginCalendar } = await import('@/plugins/packages/host-calendar');
    const limit = ctx.query.limit === undefined ? undefined : Number.parseInt(ctx.query.limit, 10) || undefined;
    return outcomeOf(ctx, details, await listPluginCalendar(grant, principal, { from: ctx.query.from, to: ctx.query.to, limit }));
  }), {
    query: t.Object({ from: t.String({ maxLength: 40 }), to: t.String({ maxLength: 40 }), limit: t.Optional(t.String({ maxLength: 4 })) }),
    detail: { tags: ['plugin-host'] },
  })

  // Create an event in a connected calendar. A write or external tool only.
  .post('/calendar/events', (ctx) => run(ctx, 'calendar.create', 'calendar:write', async ({ grant, principal }, details) => {
    const { createPluginEvent } = await import('@/plugins/packages/host-calendar');
    const { provider, ...input } = ctx.body;
    const out = await createPluginEvent(grant, principal, provider, input);
    if (out.ok) Object.assign(details, { provider, eventId: out.value.id });
    return outcomeOf(ctx, details, out);
  }), { body: calendarEvent, detail: { tags: ['plugin-host'] } })

  // Change an event this package created.
  .put('/calendar/events/:id', (ctx) => run(ctx, 'calendar.update', 'calendar:write', async ({ grant, principal }, details) => {
    const { updatePluginEvent } = await import('@/plugins/packages/host-calendar');
    const { provider, ...input } = ctx.body;
    Object.assign(details, { provider, eventId: ctx.params.id });
    return outcomeOf(ctx, details, await updatePluginEvent(grant, principal, provider, ctx.params.id, input));
  }), { params: t.Object({ id: t.String({ minLength: 1, maxLength: 1024 }) }), body: calendarEvent, detail: { tags: ['plugin-host'] } })

  // A notification to the user who triggered the call (and to nobody else).
  .post('/notify', (ctx) => run(ctx, 'notify', 'notify', async ({ grant, principal }) => {
    const { getNotificationService } = await import('@/core/notification-service');
    await getNotificationService().notify(grant.userId, 'plugin', ctx.body.title, ctx.body.body,
      { plugin: grant.plugin, tool: grant.tool }, { workspaceId: principal.workspaceId ?? null });
    return { ok: true };
  }), {
    body: t.Object({
      title: t.String({ minLength: 1, maxLength: 200 }),
      body: t.Optional(t.String({ maxLength: 2000 })),
    }),
    detail: { tags: ['plugin-host'] },
  });

/** Exported for the catalog and tests: the endpoints and the scope each needs. */
export const PLUGIN_HOST_ENDPOINTS: ReadonlyArray<{ method: string; path: string; scope: PluginHostScope | null }> = [
  { method: 'GET', path: '/api/plugin-host/whoami', scope: null },
  { method: 'GET', path: '/api/plugin-host/notes', scope: 'notes:read' },
  { method: 'POST', path: '/api/plugin-host/notes', scope: 'notes:write' },
  { method: 'GET', path: '/api/plugin-host/tasks', scope: 'tasks:read' },
  { method: 'POST', path: '/api/plugin-host/tasks', scope: 'tasks:write' },
  { method: 'GET', path: '/api/plugin-host/documents/:id', scope: 'documents:read' },
  { method: 'POST', path: '/api/plugin-host/documents', scope: 'documents:write' },
  { method: 'PUT', path: '/api/plugin-host/documents/:id', scope: 'documents:write' },
  { method: 'POST', path: '/api/plugin-host/notify', scope: 'notify' },
  { method: 'POST', path: '/api/plugin-host/web/read', scope: 'web:read' },
  { method: 'POST', path: '/api/plugin-host/model/complete', scope: 'model:complete' },
  { method: 'POST', path: '/api/plugin-host/agent/runs', scope: 'agent:run' },
  { method: 'GET', path: '/api/plugin-host/agent/runs/:id', scope: 'agent:run' },
  { method: 'DELETE', path: '/api/plugin-host/agent/runs/:id', scope: 'agent:run' },
  { method: 'GET', path: '/api/plugin-host/store', scope: 'store:read' },
  { method: 'GET', path: '/api/plugin-host/store/:key', scope: 'store:read' },
  { method: 'PUT', path: '/api/plugin-host/store/:key', scope: 'store:write' },
  { method: 'DELETE', path: '/api/plugin-host/store/:key', scope: 'store:write' },
  { method: 'GET', path: '/api/plugin-host/mail/accounts', scope: 'mail:read' },
  { method: 'GET', path: '/api/plugin-host/mail/messages', scope: 'mail:read' },
  { method: 'GET', path: '/api/plugin-host/mail/messages/:id', scope: 'mail:read' },
  { method: 'POST', path: '/api/plugin-host/mail/drafts', scope: 'mail:draft' },
  { method: 'PUT', path: '/api/plugin-host/mail/drafts/:id', scope: 'mail:draft' },
  { method: 'POST', path: '/api/plugin-host/mail/drafts/:id/send', scope: 'mail:send' },
  { method: 'POST', path: '/api/plugin-host/mail/send', scope: 'mail:send' },
  { method: 'GET', path: '/api/plugin-host/calendar/events', scope: 'calendar:read' },
  { method: 'POST', path: '/api/plugin-host/calendar/events', scope: 'calendar:write' },
  { method: 'PUT', path: '/api/plugin-host/calendar/events/:id', scope: 'calendar:write' },
];
