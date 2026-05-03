import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';
import { eq } from 'drizzle-orm';
import { Elysia, } from 'elysia';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { users } from '@/db/schema/users';
import { getApiTokenManager, looksLikeApiToken } from '@/security/api-tokens';
import { getSessionManager } from '@/security/auth/session';
import {
  ANONYMOUS_PRINCIPAL,
  type Principal,
  principalFromMasterKey,
  principalFromUser,
} from '@/security/principal';
import { secureCompare } from '@/utils/crypto';
import { apiLogger } from '@/utils/logger';
import { setupGatewayWebSocket } from './gateway-ws';
import { auditShadowMiddleware } from './middleware/audit-shadow';
import { authGuard } from './middleware/auth-guard';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { adminRoutes } from './routes/admin';
import { agentRoutes } from './routes/agents';
import { apiTokenRoutes } from './routes/api-tokens';
// Import routes
import { authRoutes } from './routes/auth';
import { channelBindingRoutes } from './routes/channel-bindings';
import { chatRoutes } from './routes/chat';
import { deviceRoutes } from './routes/devices';
import { documentRoutes } from './routes/documents';
import { evalRoutes } from './routes/eval';
import { evaluationRoutes } from './routes/evaluations';
import { expertRoutes } from './routes/experts';
import { gatewayRoutes } from './routes/gateway';
import { healthRoutes } from './routes/health';
import { hookRoutes } from './routes/hooks';
import { knowledgeRoutes } from './routes/knowledge';
import { mcpRoutes } from './routes/mcp';
import { modelRoutes } from './routes/models';
import { notificationRoutes } from './routes/notifications';
import { oauthRoutes } from './routes/oauth';
import { pipelineRoutes } from './routes/pipelines';
import { pluginRoutes } from './routes/plugins';
import { recurringTaskRoutes } from './routes/recurring-tasks';
import { searchRoutes } from './routes/search';
import { sessionRoutes } from './routes/sessions';
import { settingsRoutes } from './routes/settings';
import { skillProposalRoutes } from './routes/skill-proposals';
import { skillTopicAssignmentRoutes } from './routes/skill-topic-assignments';
import { skillRoutes } from './routes/skills';
import { swarmRoutes } from './routes/swarm';
import { teamsWebhookRoutes } from './routes/teams-webhook';
import { toolRoutes } from './routes/tools';
import { trajectoryRoutes } from './routes/trajectories';
import { vaultRoutes } from './routes/vault';
import { voiceRoutes } from './routes/voice';
import { webhookIncomingRoutes } from './routes/webhook-incoming';
import { webhookRoutes } from './routes/webhooks';
import { whatsappWebhookRoutes } from './routes/whatsapp-webhook';
import { workspaceRoutes } from './routes/workspace';
import { setupWebSocket } from './websocket';

export function createServer() {
  const config = getConfig();

  const app = new Elysia()
    // Swagger documentation
    .use(
      swagger({
        documentation: {
          info: {
            title: 'Octipus API',
            version: '1.0.0',
            description: 'Autonomous Development Octipus API',
          },
          tags: [
            { name: 'auth', description: 'Authentication endpoints' },
            { name: 'agents', description: 'Agent management' },
            { name: 'sessions', description: 'Session management' },
            { name: 'models', description: 'Model configuration' },
            { name: 'hooks', description: 'Hook management' },
            { name: 'health', description: 'Health checks' },
          ],
        },
      })
    )
    // CORS — supports wildcard '*' for LAN access or a list of origins
    .use(
      cors({
        origin: config.api.corsOrigins.includes('*') ? true : config.api.corsOrigins,
        credentials: !config.api.corsOrigins.includes('*'),
      })
    )
    // Security headers
    .onAfterHandle(({ set }) => {
      set.headers['X-Content-Type-Options'] = 'nosniff';
      set.headers['X-Frame-Options'] = 'DENY';
      set.headers['X-XSS-Protection'] = '0';
      set.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin';
      set.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:";
      set.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
    })
    // Request logging
    .onRequest(({ request }) => {
      apiLogger.debug({ method: request.method, url: request.url }, 'Request received');
    })
    // Error handling
    .onError(({ error, code }) => {
      apiLogger.error({ error, code }, 'Request error');

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
      const multiuserEnabled = !!getConfig().multiuser?.enabled;

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
              principal: principalFromUser(userObj, token),
            };
          }
        }
      }

      if (!session) {
        // MASTER_KEY Bearer fallback — single-user / MCP convenience.
        // Disabled when multi-user mode is on (Phase 1+ removes it).
        if (!multiuserEnabled) {
          const masterKey = process.env.MASTER_KEY;
          if (masterKey && secureCompare(token, masterKey)) {
            apiLogger.warn(
              { ip: request.headers.get('x-forwarded-for') || 'unknown', path: new URL(request.url).pathname },
              'MASTER_KEY authentication used — admin user access'
            );
            // Resolve to the first admin user so UUID-typed queries work
            const db = getDb();
            const [adminUser] = await db.select({ id: users.id, username: users.username })
              .from(users).where(eq(users.isAdmin, true)).orderBy(users.createdAt).limit(1);
            if (adminUser) {
              const userObj = { id: adminUser.id, username: adminUser.username, isAdmin: true };
              return {
                user: userObj,
                session: null,
                principal: principalFromMasterKey(userObj),
              };
            }
            // Fallback if no admin user exists yet — keep legacy 'system' shape.
            const fallback = { id: 'system', username: 'system', isAdmin: true };
            return {
              user: fallback,
              session: null,
              principal: principalFromMasterKey(fallback),
            };
          }
        }
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
              id: users.id, username: users.username, isAdmin: users.isAdmin,
            }).from(users).where(eq(users.id, active.targetUserId)).limit(1);
            if (target) {
              const targetObj = { id: target.id, username: target.username, isAdmin: target.isAdmin };
              const principal = {
                ...principalFromUser(targetObj, token),
                actorUserId: userObj.id,
                actorUsername: userObj.username,
              };
              return { user: targetObj, session, principal };
            }
          }
        } catch (err) {
          apiLogger.warn({ err }, 'Impersonation lookup failed; proceeding as admin');
        }
      }

      return {
        user: userObj,
        session,
        principal: principalFromUser(userObj, token),
      };
    })
    // Rate limiting on auth endpoints (must be before routes)
    .use(rateLimitMiddleware)
    // Auth guard — reject unauthenticated requests to protected routes
    .use(authGuard)
    // Multi-user phase 0 — shadow-mode audit middleware. Logs one row per
    // state-changing request. Never blocks; gated by config.multiuser.auditShadow.
    .use(auditShadowMiddleware)
    // Routes
    .group('/api', (app) =>
      app
        .use(healthRoutes)
        .use(authRoutes)
        .use(apiTokenRoutes)
        .use(channelBindingRoutes)
        .use(adminRoutes)
        .use(agentRoutes)
        .use(sessionRoutes)
        .use(modelRoutes)
        .use(hookRoutes)
        .use(vaultRoutes)
        .use(chatRoutes)
        .use(pipelineRoutes)
        .use(mcpRoutes)
        .use(toolRoutes)
        .use(voiceRoutes)
        .use(notificationRoutes)
        .use(workspaceRoutes)
        .use(oauthRoutes)
        .use(settingsRoutes)
        .use(expertRoutes)
        .use(skillTopicAssignmentRoutes)
        .use(skillRoutes)
        .use(recurringTaskRoutes)
        .use(evalRoutes)
        .use(evaluationRoutes)
        .use(documentRoutes)
        .use(knowledgeRoutes)
        .use(pluginRoutes)
        .use(searchRoutes)
        .use(deviceRoutes)
        .use(gatewayRoutes)
        .use(trajectoryRoutes)
        .use(skillProposalRoutes)
        .use(swarmRoutes)
    );

  // Webhooks — unauthenticated, outside /api group
  app.group('/api', (app) => app.use(webhookRoutes));

  // WhatsApp webhook — unauthenticated (Meta calls directly)
  app.group('/api', (app) => app.use(whatsappWebhookRoutes));

  // Teams webhook — unauthenticated (Azure Bot Framework calls directly)
  app.group('/api', (app) => app.use(teamsWebhookRoutes));

  // Incoming webhooks — unauthenticated (uses per-hook webhookSecret for auth)
  app.group('/api', (app) => app.use(webhookIncomingRoutes));

  // WebSocket setup (includes /ws, /ws/permissions, /ws/browser-bridge)
  setupWebSocket(app as any);

  // Gateway WebSocket hub (new unified protocol at /gateway)
  setupGatewayWebSocket(app as any);

  return app;
}

export async function startServer() {
  const config = getConfig();
  const app = createServer();

  app.listen({
    hostname: config.api.host,
    port: config.api.port,
  });

  apiLogger.info({ host: config.api.host, port: config.api.port }, 'API server started');

  return app;
}
