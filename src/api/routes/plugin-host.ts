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
import { and, eq } from 'drizzle-orm';
import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import { checkRateLimit } from '@/core/artifacts/rate-limit';
import { NoteExistsError, getNoteService } from '@/core/knowledge/notes';
import { raiseSessionLevel } from '@/core/protection/session-level';
import { auditTaskMutation } from '@/core/tasks/audit';
import { getDb } from '@/db/postgres';
import { auditRepository } from '@/db/repositories/audit-repository';
import { contentRepos } from '@/db/repositories/content';
import { users } from '@/db/schema/users';
import { type HostTokenGrant, verifyHostToken } from '@/plugins/packages/host-api';
import { HOST_API_EGRESS_HEADER } from '@/security/egress-proxy';
import type { Principal } from '@/security/principal';
import { SpaceError, spaceErrorStatus } from '@/security/space-access';
import type { PluginHostScope } from '@/shared/plugin-package';
import { effectiveProtectionLevel } from '@/shared/protection';
import { apiLogger } from '@/utils/logger';

type Set = { status?: number | string; headers: Record<string, string> };
interface HostCtx { request: Request; set: Set }

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
  // Through the package's egress proxy only: it names the package.
  if (!plugin || !/^[a-z][a-z0-9-]{1,49}$/.test(plugin)) return refuse(401, 'The host API is reached through the package\'s egress proxy', 'not_via_proxy');
  const grant = token ? verifyHostToken(token, plugin) : null;
  if (!grant) return refuse(401, 'A valid host API token for this package is required', 'invalid_token');
  const limited = checkRateLimit(`plugin-host:${grant.plugin}:${grant.userId}`, { capacity: 60, refillPerSecond: 10 });
  if (!limited.allowed) {
    ctx.set.headers['retry-after'] = String(limited.retryAfterSeconds ?? 1);
    return refuse(429, 'Too many host API requests', 'rate_limited', grant);
  }
  if (scope && !grant.scopes.includes(scope)) return refuse(403, `This call's token does not carry the scope ${scope}`, 'scope_missing', grant);
  const principal = await principalOf(grant);
  if (!principal) return refuse(403, 'The user or workspace of this call is no longer available', 'principal_gone', grant);
  return { grant, principal };
}

/** Run an endpoint body: audit the outcome, map a space refusal to its status. */
async function run<T>(ctx: HostCtx, op: string, scope: PluginHostScope | null, body: (a: Authorized) => Promise<T>): Promise<T | { error: string; code?: string }> {
  const a = await authorize(ctx, op, scope);
  if ('error' in a) return a;
  try {
    const out = await body(a);
    const status = typeof ctx.set.status === 'number' ? ctx.set.status : 200;
    await audit(a.grant, a.grant.plugin, op, status, scope ? { scope } : {});
    return out;
  } catch (err) {
    if (err instanceof SpaceError) {
      const status = spaceErrorStatus(err);
      ctx.set.status = status;
      await audit(a.grant, a.grant.plugin, op, status, { scope, code: err.code });
      return { error: err.message, code: err.code };
    }
    apiLogger.error({ err, plugin: a.grant.plugin, op }, 'plugin-host: request failed');
    ctx.set.status = 500;
    await audit(a.grant, a.grant.plugin, op, 500, { scope });
    return { error: 'The host API request failed' };
  }
}

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
  .post('/notes', (ctx) => run(ctx, 'notes.create', 'notes:write', async ({ grant, principal }) => {
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
  .get('/tasks', (ctx) => run(ctx, 'tasks.list', 'tasks:read', async ({ principal }) => {
    const status = ctx.query.status;
    const tasks = await contentRepos(principal).tasks.listOwn(status ? { status } : {});
    return {
      tasks: tasks.slice(0, 200).map((x) => ({
        id: x.id, title: x.title, notes: x.notes, status: x.status, priority: x.priority, category: x.category, dueAt: x.dueAt, createdAt: x.createdAt,
      })),
    };
  }), {
    query: t.Object({ status: t.Optional(t.Union(['open', 'in_progress', 'done', 'archived'].map((s) => t.Literal(s)))) }),
    detail: { tags: ['plugin-host'] },
  })

  // Create a task for the user.
  .post('/tasks', (ctx) => run(ctx, 'tasks.create', 'tasks:write', async ({ grant, principal }) => {
    const dueAt = ctx.body.dueAt ? new Date(ctx.body.dueAt) : null;
    if (dueAt && Number.isNaN(dueAt.getTime())) {
      ctx.set.status = 400;
      return { error: 'dueAt is not a date', code: 'invalid' };
    }
    const task = await contentRepos(principal).tasks.create({
      title: ctx.body.title,
      notes: ctx.body.notes ?? null,
      priority: ctx.body.priority ?? 0,
      dueAt,
      source: 'agent',
      sourceRef: { plugin: grant.plugin, tool: grant.tool } as never,
    });
    await auditTaskMutation({
      userId: task.userId, taskId: task.id, op: 'create', change: ['title', 'notes', 'priority', 'dueAt'],
      actor: { kind: 'system', id: `plugin:${grant.plugin}` }, runId: grant.sessionId,
    });
    return { id: task.id, title: task.title, status: task.status };
  }), {
    body: t.Object({
      title: t.String({ minLength: 1, maxLength: 500 }),
      notes: t.Optional(t.String({ maxLength: 10_000 })),
      priority: t.Optional(t.Integer({ minimum: 0, maximum: 3 })),
      dueAt: t.Optional(t.String({ maxLength: 40 })),
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
    // The text goes back into the calling conversation with the tool's result.
    if (grant.sessionId) raiseSessionLevel(grant.sessionId, doc.protectionLevel);
    return {
      id: doc.id, name: doc.originalName, mimeType: doc.mimeType, size: doc.size, category: doc.category,
      summary: doc.summary, text: doc.ocrText, protectionLevel: level, createdAt: doc.createdAt,
    };
  }), {
    params: t.Object({ id: t.String({ maxLength: 64 }) }),
    detail: { tags: ['plugin-host'] },
  })

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
  { method: 'POST', path: '/api/plugin-host/notify', scope: 'notify' },
];
