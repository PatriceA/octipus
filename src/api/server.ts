import { eq } from 'drizzle-orm';
import { cors, Elysia, listen, type RunningServer } from '@/api/http';
import { getConfig } from '@/config';
import { setupFederationWebSocket } from '@/core/federation/host-server';
import { getDb } from '@/db/postgres';
import { users } from '@/db/schema/users';
import { getApiTokenManager, looksLikeApiToken } from '@/security/api-tokens';
import { getSessionManager } from '@/security/auth/session';
import { SpaceError, spaceErrorStatus } from '@/security/space-access';
import {
  ANONYMOUS_PRINCIPAL,
  type Principal,
  principalFromUser,
} from '@/security/principal';
import { apiLogger } from '@/utils/logger';
import { setupGatewayWebSocket } from './gateway-ws';
import { auditShadowMiddleware } from './middleware/audit-shadow';
import { authGuard } from './middleware/auth-guard';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { adminRoutes } from './routes/admin';
import { adminApprovalRoutes } from './routes/admin-approvals';
import { agentRoutes } from './routes/agents';
import { apiTokenRoutes } from './routes/api-tokens';
import { artifactPageRoutes, artifactPageRoutesFallback } from './routes/artifact-pages';
import { artifactRoutes } from './routes/artifacts';
// Import routes
import { authRoutes } from './routes/auth';
import { channelBindingRoutes } from './routes/channel-bindings';
import { groupChannelRoutes } from './routes/group-channels';
import { meModelRoutes } from './routes/me-models';
import { chatRoutes } from './routes/chat';
import { openaiCompatRoutes } from './routes/openai-compat';
import { deviceRoutes } from './routes/devices';
import { documentRoutes } from './routes/documents';
import { emailRoutes } from './routes/email';
import { evalRoutes } from './routes/eval';
import { evaluationRoutes } from './routes/evaluations';
import { gatewayRoutes } from './routes/gateway';
import { healthRoutes } from './routes/health';
import { hookRoutes } from './routes/hooks';
import { knowledgeRoutes } from './routes/knowledge';
import { logRoutes } from './routes/logs';
import { connectorRoutes } from './routes/connectors';
import { mcpRoutes } from './routes/mcp';
import { graphRoutes } from './routes/graph';
import { memoryRoutes } from './routes/memory';
import { metricsRoutes } from './routes/metrics';
import { noteRoutes } from './routes/notes';
import { personaRoutes } from './routes/persona';
import { modelRoutes } from './routes/models';
import { digestRoutes } from './routes/digest';
import { readerRoutes } from './routes/reader';
import { notificationRoutes } from './routes/notifications';
import { spendBudgetRoutes } from './routes/spend-budgets';
import { permissionRequestRoutes } from './routes/permission-requests';
import { oauthRoutes } from './routes/oauth';
import { orgAdminRoutes, orgMeRoutes, workspaceMeRoutes } from './routes/orgs';
import { inviteRoutes, spaceRoutes } from './routes/spaces';
import { meWorkRoutes } from './routes/me-work';
import { roomRoutes } from './routes/rooms';
import { samlRoutes } from './routes/saml';
import { scimRoutes } from './routes/scim';
import { pipelineRoutes } from './routes/pipelines';
import { pluginRoutes } from './routes/plugins';
import { recurringTaskRoutes } from './routes/recurring-tasks';
import { researchRoutes } from './routes/research';
import { searchRoutes } from './routes/search';
import { sessionRoutes } from './routes/sessions';
import { capabilitiesRoutes } from './routes/capabilities';
import { roleRoutes } from './routes/roles';
import { topicRoutes } from './routes/topics';
import { settingsRoutes } from './routes/settings';
import { skillProposalRoutes } from './routes/skill-proposals';
import { skillTopicAssignmentRoutes } from './routes/skill-topic-assignments';
import { skillRoutes } from './routes/skills';
import { swarmRoutes } from './routes/swarm';
import { taskRoutes } from './routes/tasks';
import { teamsWebhookRoutes } from './routes/teams-webhook';
import { toolRoutes } from './routes/tools';
import { trajectoryRoutes } from './routes/trajectories';
import { runRoutes } from './routes/runs';
import { verificationRoutes } from './routes/verification';
import { vaultRoutes } from './routes/vault';
import { voiceRoutes } from './routes/voice';
import { webhookIncomingRoutes } from './routes/webhook-incoming';
import { webhookRoutes } from './routes/webhooks';
import { whatsappWebhookRoutes } from './routes/whatsapp-webhook';
import { workspaceRoutes } from './routes/workspace';
import { setupWebSocket } from './websocket';

/**
 * Fixed local origins the Tauri desktop client is served from. Tauri v2 uses a
 * `tauri://localhost` / `http://tauri.localhost` custom-protocol origin in the
 * packaged app, and the dev server port (3008) during `octi desktop` dev. These
 * are the desktop app's own origins (not remote hosts), always allowed so the
 * thin client's cross-origin requests reach the backend.
 */
const DESKTOP_ORIGINS = [
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'http://localhost:3008',
];

type Resolution = Awaited<ReturnType<typeof import('@/security/workspace-resolver').resolveWorkspace>>;

/** The principal of a request in the resolved workspace (personal or a space). */
function withWorkspace(principal: Principal, resolution: Resolution): Principal {
  const { workspaceKind: _k, spaceRole: _r, spaceScope: _s, spaceArchived: _a, ...base } = principal;
  void _k; void _r; void _s; void _a;
  if (resolution.workspaceKind !== 'shared') {
    return { ...base, workspaceId: resolution.workspaceId, workspaceKind: 'personal' };
  }
  return {
    ...base,
    workspaceId: resolution.workspaceId,
    workspaceKind: 'shared',
    spaceRole: resolution.spaceRole,
    spaceScope: resolution.spaceScope ?? null,
    spaceArchived: resolution.spaceArchived ?? false,
  };
}

/**
 * A header naming a space reaches the space only on `SPACE_ROUTES`
 * (docs/plans/coworking-spec.md §5.4). Every other route runs in the
 * caller's default personal workspace — except one that addresses a
 * session, agent or pipeline by id to read or stop it: that one runs in
 * the row's workspace when it is this space.
 */
async function routeWorkspace(userId: string, resolution: Resolution, method: string, url: URL): Promise<Resolution> {
  const { isSpaceRoute, spaceTargetOf } = await import('./space-routes');
  if (isSpaceRoute(url.pathname)) return resolution;
  const { defaultWorkspaceResolution, workspaceOfTarget } = await import('@/security/workspace-resolver');
  const target = spaceTargetOf(method, url.pathname, url.searchParams);
  if (target && (await workspaceOfTarget(userId, target)) === resolution.workspaceId) return resolution;
  return defaultWorkspaceResolution(userId);
}

export function createServer() {
  const config = getConfig();

  const app = new Elysia()
    // CORS — supports wildcard '*' for LAN access or a list of origins.
    // The Tauri desktop client is a thin client served from its own fixed local
    // origin (no same-origin /api proxy like the web build), so its cross-origin
    // requests need those origins allowed. These are the desktop app's OWN local
    // origins — not remote exposure — so they're always allowed unless the user
    // has opted into wildcard CORS.
    .use(
      cors({
        origin: config.api.corsOrigins.includes('*')
          ? true
          : [...config.api.corsOrigins, ...DESKTOP_ORIGINS],
        credentials: !config.api.corsOrigins.includes('*'),
      })
    )
    // Security headers
    .onAfterHandle(({ set, request }) => {
      set.headers['X-Content-Type-Options'] = 'nosniff';
      set.headers['X-XSS-Protection'] = '0';
      set.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin';
      set.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';

      // Artifact pages and embeds intentionally render in iframes and
      // set their own CSP (with `frame-ancestors` controlling who can
      // embed them). Applying the strict global X-Frame-Options/CSP here
      // would override that and break the outer→embed iframe load.
      const path = new URL(request.url).pathname;
      const isArtifactPage = path.startsWith('/a/') || path.startsWith('/__artifacts__/');
      if (!isArtifactPage) {
        set.headers['X-Frame-Options'] = 'DENY';
        set.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:";
      }
    })
    // Request logging
    .onRequest(({ request }) => {
      apiLogger.debug({ method: request.method, url: request.url }, 'Request received');
    })
    // Error handling
    .onError(({ error, code, set }) => {
      // A space access refusal from the access layer (`contentRepos`) is
      // its typed status — 404 for a non-member, 403 for a role that lacks
      // the action, 409 for an archived space — never a 500.
      if (error instanceof SpaceError) {
        set.status = spaceErrorStatus(error);
        return { error: error.message, code: error.code };
      }
      // Routine client-side conditions (unknown route, bad input) are normal
      // request flow, not server errors — log them at debug so real 5xx errors
      // stand out. Everything else stays at error level.
      if (code === 'NOT_FOUND' || code === 'VALIDATION') {
        apiLogger.debug({ code }, 'Request rejected');
      } else {
        // Error's message/stack are non-enumerable, so `{ error }` serialized to
        // an empty `{}` and hid every real failure. Pull them out explicitly.
        const detail =
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : { value: String(error) };
        apiLogger.error({ code, error: detail }, 'Request error');
      }

      if (code === 'VALIDATION') {
        return { error: 'Invalid request data' };
      }

      if (code === 'NOT_FOUND') {
        return { error: 'Not found' };
      }

      return { error: 'Internal server error' };
    })
    // Auth middleware helper
    //
    // Produces three context fields:
    //   - `user`      : legacy plain-object form, kept for backwards compat
    //                   with every existing route that reads `ctx.user`.
    //   - `session`   : the validated auth-session record (or null).
    //   - `principal` : the Principal type used by the multi-user code path.
    //                   Phase 0: populated alongside `user` for every
    //                   request; downstream code may opt in.
    //                   Phase 1: becomes the only auth signal and `user`
    //                   gets removed.
    .derive(async ({ request }) => {
      const authHeader = request.headers.get('authorization');
      const sessionManager = getSessionManager();

      let token: string | undefined;

      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      } else {
        // Fallback: check for session_token cookie
        const cookieHeader = request.headers.get('cookie') || '';
        const cookieMatch = cookieHeader.match(/session_token=([^;]+)/);
        if (cookieMatch) {
          token = cookieMatch[1];
        }
      }

      if (!token) {
        return { user: null, session: null, principal: ANONYMOUS_PRINCIPAL as Principal };
      }
      const session = await sessionManager.validate(token);

      // Phase 2a — personal access token Bearer.
      // Tried after session validation so cookie-based browser auth
      // takes precedence (and so a session cookie that happens to
      // start with `octi_` for some reason isn't shadowed). The shape
      // check (`looksLikeApiToken`) avoids a DB roundtrip on
      // non-token Bearer values like the legacy MASTER_KEY.
      if (!session && looksLikeApiToken(token)) {
        const validated = await getApiTokenManager().validate(token);
        if (validated) {
          const db = getDb();
          const [u] = await db
            .select({ id: users.id, username: users.username, isAdmin: users.isAdmin })
            .from(users)
            .where(eq(users.id, validated.userId))
            .limit(1);
          if (u) {
            const userObj = { id: u.id, username: u.username, isAdmin: u.isAdmin };
            return {
              user: userObj,
              session: null,
              // WS6 — carry the token's scopes onto the principal so guarded
              // surfaces can enforce them. Empty ⇒ unscoped ⇒ full access, so we
              // only attach a non-empty set (keeps the principal shape identical
              // to browser-session auth for every existing token).
              principal: {
                ...principalFromUser(userObj, token),
                ...(validated.scopes.length > 0 ? { scopes: validated.scopes } : {}),
              },
            };
          }
        }
      }

      if (!session) {
        // No session and no valid API token → anonymous. (The legacy
        // MASTER_KEY Bearer fallback was removed with single-user mode —
        // automation must mint a scoped API token via POST /api/tokens.)
        return { user: null, session: null, principal: ANONYMOUS_PRINCIPAL as Principal };
      }

      const userObj = {
        id: session.userId,
        username: session.username,
        isAdmin: session.isAdmin,
      };

      // Phase 3d — admin impersonation. If the admin's session token
      // has an active impersonation row, swap the request's identity
      // to the target user but stamp the principal with actorUserId
      // so downstream audit can record both sides.
      if (userObj.isAdmin) {
        try {
          const { getImpersonationManager } = await import('@/security/impersonation');
          const active = await getImpersonationManager().findActive(token);
          if (active) {
            const db = getDb();
            const [target] = await db.select({
              id: users.id, username: users.username, isAdmin: users.isAdmin, isActive: users.isActive, kind: users.kind,
            }).from(users).where(eq(users.id, active.targetUserId)).limit(1);
            // A deactivated (or deleted) target ends the impersonation: the
            // admin carries on as themselves. So does a remote member's row
            // (S7): it never signs in here, so nobody acts as it.
            if (!target?.isActive || target.kind !== 'local') {
              await getImpersonationManager().stop(token, 'target_inactive');
            } else {
              const targetObj = { id: target.id, username: target.username, isAdmin: target.isAdmin };
              const principal = {
                ...principalFromUser(targetObj, token),
                actorUserId: userObj.id,
                actorUsername: userObj.username,
              };
              return {
                user: targetObj,
                session: { ...session, token } as typeof session & { token: string },
                principal,
              };
            }
          }
        } catch (err) {
          apiLogger.warn({ err }, 'Impersonation lookup failed; proceeding as admin');
        }
      }

      return {
        user: userObj,
        // Attach the raw bearer/cookie token onto the session record so
        // routes that need it (e.g. /admin/impersonate, which uses the
        // admin's session token as the impersonation lookup key) can
        // read `session.token` without a second cookie/header dance.
        // SessionData itself doesn't store the token (only its sha256
        // hash) so we splice it in at the request boundary.
        session: { ...session, token } as typeof session & { token: string },
        principal: principalFromUser(userObj, token),
      };
    })
    // Phase 4 — workspace resolution. Layered as a second `.derive()`
    // so the auth branch above stays a flat early-return list. The
    // resolver maps the `X-Octipus-Workspace` header (slug, uuid, or
    // "all") to a workspace id owned by the principal; cross-tenant or
    // unknown headers collapse to the user's default workspace. A space
    // the caller is a member of resolves to it (shared, with their role)
    // on `SPACE_ROUTES` only; a space they are not a member of is a 404.
    //
    // Fails closed: a principal without its workspace would read every
    // workspace's rows (the scoped repositories drop the workspace filter
    // when there is none), so a resolver failure answers 503 below instead
    // of continuing unscoped. A derive cannot answer, hence the flag.
    .derive(async ({ request, principal }) => {
      if (!principal || principal.kind === 'anonymous') return {};
      const header = request.headers.get('x-octipus-workspace');
      try {
        const { defaultWorkspaceResolution, resolveWorkspace } = await import('@/security/workspace-resolver');
        let resolution = await resolveWorkspace(principal, header);
        const url = new URL(request.url);
        if (resolution.denied) {
          // A space the caller is not (or no longer) a member of: 404 below
          // (I3), except on the few paths a client needs to recover.
          const { isDeniedWorkspaceExempt } = await import('./space-routes');
          if (!isDeniedWorkspaceExempt(request.method, url.pathname)) return { workspaceDenied: true };
          resolution = await defaultWorkspaceResolution(principal.userId);
        } else if (resolution.workspaceKind === 'shared') {
          resolution = await routeWorkspace(principal.userId, resolution, request.method, url);
        }
        if (resolution.workspaceId === null) return {};
        return { principal: withWorkspace(principal, resolution) };
      } catch (err) {
        apiLogger.error({ err, userId: principal.userId }, 'Workspace resolution failed; refusing the request');
        return { workspaceUnresolved: true };
      }
    })
    .onBeforeHandle((ctx) => {
      if (!(ctx as { workspaceUnresolved?: boolean }).workspaceUnresolved) return;
      ctx.set.status = 503;
      return { error: 'Workspace unavailable. Try again shortly.' };
    })
    // Rate limiting on auth endpoints (must be before routes)
    .use(rateLimitMiddleware)
    // Auth guard — reject unauthenticated requests to protected routes
    .use(authGuard)
    // A workspace header naming a space the caller is not a member of: 404 on
    // `/api` and `/v1` (I3), whatever the route — the client learns the space
    // is gone instead of acting in another workspace.
    .onBeforeHandle((ctx) => {
      if (!(ctx as { workspaceDenied?: boolean }).workspaceDenied) return;
      const { pathname } = new URL(ctx.request.url);
      if (!pathname.startsWith('/api/') && !pathname.startsWith('/v1/')) return;
      ctx.set.status = 404;
      // The code tells a client this is its selected workspace going away
      // (the web switches to the default one), not a missing resource.
      return { error: 'Space not found', code: 'workspace_denied' };
    })
    // Multi-user phase 0 — shadow-mode audit middleware. Logs one row per
    // state-changing request. Never blocks; gated by config.multiuser.auditShadow.
    .use(auditShadowMiddleware)
    // Routes
    .group('/api', (app) =>
      app
        .use(healthRoutes)
        // Every counter and histogram in `core/telemetry.ts` fed a registry
        // nothing exposed: the route existed, its test passed, and it was never
        // mounted. A route that is not `.use`d is not reachable, whatever its
        // unit test says.
        .use(metricsRoutes)
        .use(authRoutes)
        .use(apiTokenRoutes)
        .use(channelBindingRoutes)
        .use(groupChannelRoutes)
        .use(meModelRoutes)
        .use(meWorkRoutes)
        .use(adminRoutes)
        .use(adminApprovalRoutes)
        .use(orgAdminRoutes)
        .use(orgMeRoutes)
        .use(workspaceMeRoutes)
        .use(spaceRoutes)
        .use(roomRoutes)
        .use(inviteRoutes)
        .use(scimRoutes)
        .use(samlRoutes)
        .use(agentRoutes)
        .use(sessionRoutes)
        .use(modelRoutes)
        .use(hookRoutes)
        .use(taskRoutes)
        .use(readerRoutes)
        .use(digestRoutes)
        .use(emailRoutes)
        .use(vaultRoutes)
        .use(chatRoutes)
        .use(pipelineRoutes)
        .use(connectorRoutes)
        .use(mcpRoutes)
        .use(toolRoutes)
        .use(roleRoutes)
        .use(topicRoutes)
        .use(voiceRoutes)
        .use(notificationRoutes)
        .use(spendBudgetRoutes)
        .use(permissionRequestRoutes)
        .use(workspaceRoutes)
        .use(oauthRoutes)
        .use(settingsRoutes)
        .use(capabilitiesRoutes)
        .use(skillTopicAssignmentRoutes)
        .use(skillRoutes)
        .use(artifactRoutes)
        .use(recurringTaskRoutes)
        .use(researchRoutes)
        .use(evalRoutes)
        .use(evaluationRoutes)
        .use(documentRoutes)
        .use(knowledgeRoutes)
        .use(logRoutes)
        .use(memoryRoutes)
        .use(noteRoutes)
        .use(graphRoutes)
        .use(personaRoutes)
        .use(pluginRoutes)
        .use(searchRoutes)
        .use(deviceRoutes)
        .use(gatewayRoutes)
        .use(trajectoryRoutes)
        .use(verificationRoutes)
        .use(runRoutes)
        .use(skillProposalRoutes)
        .use(swarmRoutes)
    );

  // OpenAI-compatible surface (WS6) — mounted at /v1, sharing the same
  // app-level auth (.derive) + auth-guard as /api. Bearer octi_ tokens are the
  // expected credential; the api:chat scope is enforced inside the route.
  app.group('/v1', (app) => app.use(openaiCompatRoutes));

  // Webhooks — unauthenticated, outside /api group
  app.group('/api', (app) => app.use(webhookRoutes));

  // WhatsApp webhook — unauthenticated (Meta calls directly)
  app.group('/api', (app) => app.use(whatsappWebhookRoutes));

  // Teams webhook — unauthenticated (Azure Bot Framework calls directly)
  app.group('/api', (app) => app.use(teamsWebhookRoutes));

  // Incoming webhooks — unauthenticated (uses per-hook webhookSecret for auth)
  app.group('/api', (app) => app.use(webhookIncomingRoutes));

  // Hosted artifact pages — outside /api group so they live at /a/:slug
  // (subdomain mode) AND /__artifacts__/a/:slug (DNS-less fallback). Both
  // mounts are always active so a fresh install works without any config.
  app.use(artifactPageRoutes);
  app.use(artifactPageRoutesFallback);

  // The browser extension's /ws/browser-bridge and the voice sockets
  setupWebSocket(app as any);

  // Gateway WebSocket hub (/gateway): the web and the TUI
  setupGatewayWebSocket(app as any);

  // Peer links from other installs (/federation), only when this one hosts
  // spaces for them (docs/plans/federation-spec.md §5.1)
  setupFederationWebSocket(app as any);

  return app;
}

export async function startServer() {
  const config = getConfig();
  const app = createServer();

  // One bind, no watchdog and no `beforeExit` surgery. Both existed to work
  // around the Bun adapter: it registered a `beforeExit` handler that stopped
  // the server under Node's semantics, and the listener could be torn down a
  // few seconds after boot with no attributable JS call — the "backend
  // reachable, then refused" bug. Neither happens on Node, so the self-healing
  // rebind loop is gone rather than carried across. If a listener ever drops
  // again it should surface as a crash, not as a silent rebind.
  apiServer = listen(app, { hostname: config.api.host, port: config.api.port });
  app.server = apiServer;

  apiLogger.info({ host: config.api.host, port: apiServer.port }, 'API server started');

  return app;
}

/** The running listener, or undefined before boot / after shutdown. */
export let apiServer: RunningServer | undefined;

/** Stop the HTTP listener (called from the shutdown path). */
export function stopApiServer() {
  apiServer?.stop();
  apiServer = undefined;
}
