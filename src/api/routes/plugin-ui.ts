/**
 * Plugin package pages (docs/PLUGIN-PACKAGES.md#pages).
 *
 * - `GET /api/plugin-ui`: the pages of the enabled packages, for the sidebar
 *   (any signed-in user).
 * - `GET /api/plugin-ui/:name/<file>`: a static file of an enabled package's
 *   UI directory, sandboxed by its CSP (src/plugins/packages/ui.ts). Public:
 *   a sandboxed frame's requests carry no cookie, and the files hold no data.
 * - `POST /api/plugins/:name/call/:tool`: the page bridge. The web app's
 *   parent frame calls it for the page, as the signed-in user, for one of
 *   that package's own declared tools; the call takes the same path as an
 *   agent's (`MCPBridge.callTool`: the tool's declared effect, the user's
 *   permission rules, space role and flow guard, protection level). The
 *   request is unattended, so a call the rules would ask about is refused
 *   with 409 `approval_required`; the web app then shows the user its own
 *   confirmation (outside the page's frame) and repeats the call with
 *   `confirm: true`, which counts as that approval for this one call only.
 *   Rate-limited per user and package.
 * - `/api/plugins/:name/store` (GET: keys) and `/api/plugins/:name/store/<key>`
 *   (GET, PUT, DELETE): the page's direct access to the package's store
 *   (docs/PLUGIN-PACKAGES.md#store), for page state between visits. The
 *   signed-in user's own entries of that package, in the workspace the page
 *   is opened in (a shared space, else their personal one), only, and only
 *   while the package is enabled, has pages, may start (not revoked, its
 *   content approved) and is granted `store:read` (reads) or `store:write`
 *   (writes); an API token needs `api:read` or `api:write`, and a
 *   cookie-signed write must come from this site. Writes share the store's
 *   write limit with the package's tools. Writes and deletes are audited in
 *   aggregate.
 */
import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import { buildAgentContext, fundingFor } from '@/core/agent/context';
import { checkRateLimit } from '@/core/artifacts/rate-limit';
import { getDb } from '@/db/postgres';
import { auditRepository } from '@/db/repositories/audit-repository';
import { pluginPackages } from '@/db/schema/plugin-packages';
import { getMCPBridge, PLUGIN_SERVER_PREFIX } from '@/mcp/bridge';
import { dashboardView, enabledDashboard, fetchDestAllowed, isSecureOrigin, listEnabledDashboards, listEnabledPages, pluginUiCsp, pluginUiHeaders, readUiFile, uiBaseUrl } from '@/plugins/packages/ui';
import { ApprovalBlockedError, withDispatchAuthorization } from '@/security/dispatch-authorization';
import { crossSiteDenied } from '@/api/plugin-route-guard';
import { isAuthenticated, requireScope } from '@/security/principal';
import { API_SCOPES } from '@/security/scopes';
import { eq } from 'drizzle-orm';
import { pluginUserDenied } from '@/api/plugin-route-guard';
import { readLevelOf } from '@/plugins/packages/read-level';
import { effectiveMaxProtection, grantedHostScopes } from '@/plugins/packages/service';
import { storeDelete, storeGet, storeKeyFromPath, storeList, type StoreOutcome, storePut, storeWriteLimit } from '@/plugins/packages/store';
import { packageRunProblem } from '@/plugins/packages/run-check';
import type { StoreScope } from '@/db/repositories/plugin-store-repository';
import { STORE_AUDIT_WINDOW_MS, storeAuditAggregator } from '@/plugins/packages/store-audit';
import type { PluginHostScope } from '@/shared/plugin-package';
import { apiLogger } from '@/utils/logger';

type StoreCtx = { request: Request; principal: Parameters<typeof pluginUserDenied>[0]['principal']; set: { status?: number | string; headers: Record<string, string> } };

/** Page store writes and deletes, audited in aggregate (src/plugins/packages/store-audit.ts). */
const pageStoreAudit = storeAuditAggregator();

/** Test-only. */
export function _resetPageStoreAudit(): void {
  pageStoreAudit.reset();
}

/**
 * The page store's gate: signed in, the token's scope (`api:read` for a read,
 * `api:write` for a write), from this site for a write, rate-limited (a
 * write also by the store's own write limit, shared with the package's
 * tools), and the package enabled with pages, allowed to start now
 * (src/plugins/packages/run-check.ts: not revoked, its content approved) and
 * granted `scope`. Whose store (the user, and the workspace the page is
 * opened in: a shared space, else the user's personal one) and the
 * package's level cap, or the refusal (written to `set`).
 */
async function pageStoreGate(ctx: StoreCtx, name: string, scope: PluginHostScope): Promise<{ store: StoreScope; maxProtection: number } | { error: string; code?: string }> {
  const denied = pluginUserDenied(ctx, scope === 'store:write' ? 'write' : 'read');
  if (denied) return denied;
  const principal = ctx.principal as { userId: string; workspaceId?: string | null; workspaceKind?: 'personal' | 'shared' };
  const userId = principal.userId;
  const limited = checkRateLimit(`plugin-page-store:${userId}:${name}`, { capacity: 60, refillPerSecond: 10 });
  const writeLimited = limited.allowed && scope === 'store:write' ? storeWriteLimit(name, userId) : null;
  const refusal = !limited.allowed ? limited : writeLimited && !writeLimited.allowed ? writeLimited : null;
  if (refusal) {
    ctx.set.status = 429;
    ctx.set.headers['retry-after'] = String(refusal.retryAfterSeconds ?? 1);
    return { error: 'Too many store requests from this page; wait a moment', code: 'rate_limited' };
  }
  const [row] = await getDb().select().from(pluginPackages).where(eq(pluginPackages.name, name)).limit(1);
  // Only an enabled package with pages, that may run now, has a bridge.
  if (!row?.enabled || !row.manifest.ui || await packageRunProblem(name) !== null) {
    ctx.set.status = 404;
    return { error: 'No such plugin page', code: 'not_found' };
  }
  const granted = grantedHostScopes(row);
  if (!granted.includes(scope)) {
    ctx.set.status = 403;
    return { error: `${name} has no approved ${scope} scope`, code: 'scope_missing' };
  }
  const workspaceId = principal.workspaceKind === 'shared' ? principal.workspaceId ?? null : null;
  return { store: { pkg: name, userId, workspaceId }, maxProtection: effectiveMaxProtection(row.manifest, granted) };
}

/** A store outcome as the answer: the value, or the refusal with its status. */
function storeAnswer<T>(ctx: StoreCtx, outcome: StoreOutcome<T>): T | { error: string; code: string; current?: number } {
  if (outcome.ok) return outcome.value;
  ctx.set.status = outcome.status;
  return { error: outcome.error, code: outcome.code, ...(outcome.current !== undefined ? { current: outcome.current } : {}) };
}

async function auditPageStore(name: string, userId: string, op: string, status: number, code: string | undefined): Promise<void> {
  await pageStoreAudit.count([name, userId, op, status, code ?? ''].join('\n'), async (count) => {
    try {
      await auditRepository.log({
        userId, action: status < 400 ? 'tool_executed' : 'permission_denied', resourceType: 'plugin_page', resourceId: name,
        details: { op, status, ...(code ? { code } : {}), count, windowMs: STORE_AUDIT_WINDOW_MS, aggregated: true },
      });
    } catch (err) {
      apiLogger.error({ err, plugin: name, op }, 'plugin page store: audit row could not be written');
    }
  });
}

const PAGE_STORE_MARKER = '/store/';
const STORE_NAME = t.Object({ name: t.String({ maxLength: 50 }) });

/** The most a page's call arguments may weigh, as JSON. */
const MAX_ARGS_CHARS = 100_000;

export const pluginUiRoutes = new Elysia({ prefix: '/plugin-ui' })
  .use(apiContext)

  .get('/', async ({ user, principal, set }) => {
    if (!user || !isAuthenticated(principal)) {
      set.status = 401;
      return { error: 'Authentication required' };
    }
    return { pages: await listEnabledPages(), dashboards: await listEnabledDashboards() };
  }, { detail: { tags: ['plugin-packages'] } })

  .get('/:name/*', async (ctx) => {
    const { name } = ctx.params;
    const marker = `/plugin-ui/${name}/`;
    const pathname = new URL(ctx.request.url).pathname;
    const at = pathname.indexOf(marker);
    let rel = '';
    try {
      rel = at >= 0 ? decodeURIComponent(pathname.slice(at + marker.length)) : '';
    } catch {
      rel = '';
    }
    const base = uiBaseUrl(ctx.request, name, ctx.socketAddress);
    // Only into the app's frame (or as a subresource of the page): never opened on its own.
    const dest = !!base && fetchDestAllowed(rel, ctx.request.headers.get('sec-fetch-dest'), isSecureOrigin(base));
    const file = base && dest ? await readUiFile(name, rel) : { status: 404 as const };
    if (file.status !== 200 || !base) {
      ctx.set.status = 404;
      ctx.set.headers['Content-Security-Policy'] = "default-src 'none'; frame-ancestors 'none'; sandbox";
      return 'Not found';
    }
    Object.assign(ctx.set.headers, pluginUiHeaders(pluginUiCsp(base), file.contentType));
    ctx.set.headers.vary = 'Sec-Fetch-Dest';
    return new Uint8Array(file.body);
  }, { detail: { tags: ['plugin-packages'] } });

export const pluginCallRoutes = new Elysia({ prefix: '/plugins' })
  .use(apiContext)

  .post('/:name/call/:tool', async ({ request, user, principal, params, body, set }) => {
    if (!user || !isAuthenticated(principal)) {
      set.status = 401;
      return { error: 'Authentication required' };
    }
    // Signed by the session cookie: only from this site (src/api/plugin-route-guard.ts).
    const crossSite = crossSiteDenied({ set, request });
    if (crossSite) return crossSite;
    const limited = checkRateLimit(`plugin-call:${user.id}:${params.name}`, { capacity: 20, refillPerSecond: 2 });
    if (!limited.allowed) {
      set.status = 429;
      set.headers['retry-after'] = String(limited.retryAfterSeconds ?? 1);
      return { error: 'Too many calls from this page; wait a moment', code: 'rate_limited' };
    }
    const [row] = await getDb().select().from(pluginPackages).where(eq(pluginPackages.name, params.name)).limit(1);
    // Only an enabled package with pages has a bridge.
    if (!row?.enabled || !row.manifest.ui) {
      set.status = 404;
      return { error: 'No such plugin page', code: 'not_found' };
    }
    // Its own declared tools only; another package's tool is not addressable from here.
    const decl = Object.hasOwn(row.manifest.tools ?? {}, params.tool) ? row.manifest.tools?.[params.tool] : undefined;
    if (!decl) {
      set.status = 404;
      return { error: `${params.name} has no tool ${params.tool}`, code: 'unknown_tool' };
    }
    const effect = decl.effect;
    // An API token: api:read for a read tool, api:write for one that changes something.
    const needed = effect === 'read' ? API_SCOPES.READ : API_SCOPES.WRITE;
    if (!requireScope(principal, needed)) {
      set.status = 403;
      return { error: `This API token lacks the ${needed} scope`, code: 'scope' };
    }
    const args = (body?.args ?? {}) as Record<string, unknown>;
    if (JSON.stringify(args).length > MAX_ARGS_CHARS) {
      set.status = 413;
      return { error: 'The arguments are too large', code: 'too_large' };
    }
    const serverId = `${PLUGIN_SERVER_PREFIX}${params.name}`;
    const scope = { workspaceId: principal.workspaceId ?? null, space: null, trigger: 'user' as const, funding: fundingFor('user', null) };
    const context = buildAgentContext({
      id: `plugin-page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: '',
      userId: user.id,
      scope,
      topic: 'plugin-page',
      model: 'plugin-page',
      role: 'general',
      // No approval channel in a request: an ASK is refused (409) and the web app asks itself.
      attended: false,
      status: 'running',
      metadata: { source: 'plugin-page', plugin: params.name },
    });
    const action = `${serverId}.${params.tool}`;
    const authArgs = { server_id: serverId, tool_name: params.tool, arguments: args };
    const call = () => getMCPBridge().callTool(serverId, params.tool, args, context, authArgs);
    try {
      let result: unknown;
      if (body?.confirm === true) {
        // The user confirmed this exact call in the app (not in the page): one approval, for these arguments.
        await auditRepository.log({
          userId: user.id, action: 'permission_granted', resourceType: 'plugin_page', resourceId: params.name,
          details: { op: 'call_confirmed', tool: params.tool, effect },
        });
        result = await withDispatchAuthorization(context, 'mcp', action, authArgs, `approval:plugin-page:${user.id}`, call);
      } else {
        result = await call();
      }
      return { result };
    } catch (err) {
      if (err instanceof ApprovalBlockedError) {
        set.status = 409;
        return { error: `${params.tool} needs your confirmation`, code: 'approval_required', tool: params.tool, effect };
      }
      const message = (err as Error).message ?? String(err);
      if (/Permission denied|not granted|revoked/i.test(message)) {
        set.status = 403;
        return { error: message, code: 'denied' };
      }
      apiLogger.warn({ err, plugin: params.name, tool: params.tool }, 'plugin page call failed');
      set.status = 502;
      return { error: `The call failed: ${message}`, code: 'call_failed' };
    }
  }, {
    params: t.Object({ name: t.String({ maxLength: 50 }), tool: t.String({ maxLength: 64 }) }),
    body: t.Object({
      args: t.Optional(t.Record(t.String(), t.Any())),
      confirm: t.Optional(t.Boolean()),
    }),
    detail: { tags: ['plugin-packages'] },
  })

  // ── Dashboards (docs/PLUGIN-PACKAGES.md#dashboards): drawn by the app, each
  // widget fed by one of the package's read tools, called as the signed-in user
  // with the arguments its manifest fixes. Nothing from the browser reaches the tool.

  // A dashboard's layout: its widgets, never their tools or input.
  .get('/:name/dashboards/:id', async ({ user, principal, params, set }) => {
    if (!user || !isAuthenticated(principal)) {
      set.status = 401;
      return { error: 'Authentication required' };
    }
    const found = await enabledDashboard(params.name, params.id);
    if (!found) {
      set.status = 404;
      return { error: 'No such dashboard', code: 'not_found' };
    }
    return dashboardView(params.name, found.manifest, found.dashboard);
  }, {
    params: t.Object({ name: t.String({ maxLength: 50 }), id: t.String({ maxLength: 40 }) }),
    detail: { tags: ['plugin-packages'] },
  })

  // One widget's data: its tool's answer, checked against the widget's type (src/plugins/packages/dashboard-data.ts).
  .post('/:name/dashboards/:id/widgets/:widget', async ({ request, user, principal, params, set }) => {
    if (!user || !isAuthenticated(principal)) {
      set.status = 401;
      return { error: 'Authentication required' };
    }
    const crossSite = crossSiteDenied({ set, request });
    if (crossSite) return crossSite;
    if (!requireScope(principal, API_SCOPES.READ)) {
      set.status = 403;
      return { error: `This API token lacks the ${API_SCOPES.READ} scope`, code: 'scope' };
    }
    // A dashboard of 24 widgets loads at once; refreshes come slower.
    const limited = checkRateLimit(`plugin-dashboard:${user.id}:${params.name}`, { capacity: 48, refillPerSecond: 1 });
    if (!limited.allowed) {
      set.status = 429;
      set.headers['retry-after'] = String(limited.retryAfterSeconds ?? 1);
      return { error: 'Too many widget requests; wait a moment', code: 'rate_limited' };
    }
    const found = await enabledDashboard(params.name, params.id);
    const widget = found?.dashboard.widgets.find((w) => w.id === params.widget);
    // The manifest was checked at install: the tool is the package's own, and a read tool.
    const decl = widget && Object.hasOwn(found?.manifest.tools ?? {}, widget.tool) ? found?.manifest.tools?.[widget.tool] : undefined;
    if (!found || !widget || decl?.effect !== 'read') {
      set.status = 404;
      return { error: 'No such widget', code: 'not_found' };
    }
    const serverId = `${PLUGIN_SERVER_PREFIX}${params.name}`;
    const scope = { workspaceId: principal.workspaceId ?? null, space: null, trigger: 'user' as const, funding: fundingFor('user', null) };
    const context = buildAgentContext({
      id: `plugin-dashboard-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: '',
      userId: user.id,
      scope,
      topic: 'plugin-dashboard',
      model: 'plugin-dashboard',
      role: 'general',
      // Nobody to ask: a rule that asks about this read tool refuses the widget instead.
      attended: false,
      status: 'running',
      metadata: { source: 'plugin-dashboard', plugin: params.name, dashboard: params.id, widget: params.widget },
    });
    const args = widget.input ?? {};
    try {
      const result = await getMCPBridge().callTool(serverId, widget.tool, args, context, { server_id: serverId, tool_name: widget.tool, arguments: args });
      const { widgetData } = await import('@/plugins/packages/dashboard-data');
      const out = widgetData(result, widget.type, found.manifest.network ?? []);
      if (!out.ok) {
        set.status = 422;
        return { error: out.error, code: 'widget_invalid' };
      }
      return { data: out.data, at: new Date().toISOString() };
    } catch (err) {
      if (err instanceof ApprovalBlockedError) {
        set.status = 409;
        return { error: `Your permission rules ask before ${widget.tool} runs; a dashboard cannot ask`, code: 'approval_required' };
      }
      const message = (err as Error).message ?? String(err);
      if (/Permission denied|not granted|revoked/i.test(message)) {
        set.status = 403;
        return { error: message, code: 'denied' };
      }
      apiLogger.warn({ err, plugin: params.name, tool: widget.tool }, 'plugin dashboard widget failed');
      set.status = 502;
      return { error: `The widget's tool failed: ${message}`, code: 'call_failed' };
    }
  }, {
    params: t.Object({ name: t.String({ maxLength: 50 }), id: t.String({ maxLength: 40 }), widget: t.String({ maxLength: 40 }) }),
    detail: { tags: ['plugin-packages'] },
  })

  // The page's store (docs/PLUGIN-PACKAGES.md#store): the signed-in user's keys of this package in the page's workspace, sorted, with size and version.
  .get('/:name/store', async (ctx) => {
    const gate = await pageStoreGate(ctx, ctx.params.name, 'store:read');
    if ('error' in gate) return gate;
    const limit = ctx.query.limit === undefined ? undefined : Number.parseInt(String(ctx.query.limit), 10);
    const outcome = await storeList(gate.store, { prefix: ctx.query.prefix, limit }, gate.maxProtection);
    if (!outcome.ok) return storeAnswer(ctx, outcome);
    const { protectionLevel: _level, ...rest } = outcome.value;
    return rest;
  }, {
    params: STORE_NAME,
    query: t.Object({ prefix: t.Optional(t.String({ maxLength: 200 })), limit: t.Optional(t.String({ maxLength: 5 })) }),
    detail: { tags: ['plugin-packages'] },
  })

  // One entry of the signed-in user: { value, version }.
  .get('/:name/store/*', async (ctx) => {
    const gate = await pageStoreGate(ctx, ctx.params.name, 'store:read');
    if ('error' in gate) return gate;
    const outcome = await storeGet(gate.store, storeKeyFromPath(ctx.request.url, `/${ctx.params.name}${PAGE_STORE_MARKER}`), gate.maxProtection);
    return storeAnswer(ctx, outcome.ok ? { ok: true, value: { value: outcome.value.value, version: outcome.value.version } } : outcome);
  }, { detail: { tags: ['plugin-packages'] } })

  // Write one entry of the signed-in user: { value, ifVersion? } → { version }, within the package's quota per user.
  .put('/:name/store/*', async (ctx) => {
    const gate = await pageStoreGate(ctx, ctx.params.name, 'store:write');
    if ('error' in gate) return gate;
    // A page sees what its package's tools show it, within the package's level: it writes at what the package has read for this user.
    const level = Math.min(gate.maxProtection, await readLevelOf(ctx.params.name, gate.store.userId));
    const outcome = await storePut(gate.store, storeKeyFromPath(ctx.request.url, `/${ctx.params.name}${PAGE_STORE_MARKER}`),
      (ctx.body ?? {}) as { value?: unknown; ifVersion?: number }, level, gate.maxProtection);
    await auditPageStore(ctx.params.name, gate.store.userId, 'store.put', outcome.ok ? 200 : outcome.status, outcome.ok ? undefined : outcome.code);
    return storeAnswer(ctx, outcome.ok ? { ok: true, value: { version: outcome.value.version } } : outcome);
  }, {
    body: t.Object({ value: t.Optional(t.Any()), ifVersion: t.Optional(t.Integer({ minimum: 0 })) }),
    detail: { tags: ['plugin-packages'] },
  })

  // Delete one entry of the signed-in user.
  .delete('/:name/store/*', async (ctx) => {
    const gate = await pageStoreGate(ctx, ctx.params.name, 'store:write');
    if ('error' in gate) return gate;
    const outcome = await storeDelete(gate.store, storeKeyFromPath(ctx.request.url, `/${ctx.params.name}${PAGE_STORE_MARKER}`), gate.maxProtection);
    await auditPageStore(ctx.params.name, gate.store.userId, 'store.delete', outcome.ok ? 200 : outcome.status, outcome.ok ? undefined : outcome.code);
    return storeAnswer(ctx, outcome.ok ? { ok: true, value: outcome.value } : outcome);
  }, { detail: { tags: ['plugin-packages'] } });
