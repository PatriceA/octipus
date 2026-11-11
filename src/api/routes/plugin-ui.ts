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
 */
import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import { buildAgentContext, fundingFor } from '@/core/agent/context';
import { checkRateLimit } from '@/core/artifacts/rate-limit';
import { getDb } from '@/db/postgres';
import { auditRepository } from '@/db/repositories/audit-repository';
import { pluginPackages } from '@/db/schema/plugin-packages';
import { getMCPBridge, PLUGIN_SERVER_PREFIX } from '@/mcp/bridge';
import { fetchDestAllowed, isSecureOrigin, listEnabledPages, pluginUiCsp, pluginUiHeaders, readUiFile, uiBaseUrl } from '@/plugins/packages/ui';
import { ApprovalBlockedError, withDispatchAuthorization } from '@/security/dispatch-authorization';
import { crossSiteDenied } from '@/api/plugin-route-guard';
import { isAuthenticated, requireScope } from '@/security/principal';
import { API_SCOPES } from '@/security/scopes';
import { eq } from 'drizzle-orm';
import { apiLogger } from '@/utils/logger';

/** The most a page's call arguments may weigh, as JSON. */
const MAX_ARGS_CHARS = 100_000;

export const pluginUiRoutes = new Elysia({ prefix: '/plugin-ui' })
  .use(apiContext)

  .get('/', async ({ user, principal, set }) => {
    if (!user || !isAuthenticated(principal)) {
      set.status = 401;
      return { error: 'Authentication required' };
    }
    return { pages: await listEnabledPages() };
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
  });
