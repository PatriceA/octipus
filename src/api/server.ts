import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';
import { getConfig } from '@/config';
import { apiLogger } from '@/utils/logger';
import { getSessionManager } from '@/security/auth/session';
import { secureCompare } from '@/utils/crypto';
import { getDb } from '@/db/postgres';
import { users } from '@/db/schema/users';
import { eq } from 'drizzle-orm';

// Import routes
import { authRoutes } from './routes/auth';
import { agentRoutes } from './routes/agents';
import { sessionRoutes } from './routes/sessions';
import { modelRoutes } from './routes/models';
import { hookRoutes } from './routes/hooks';
import { healthRoutes } from './routes/health';
import { vaultRoutes } from './routes/vault';
import { chatRoutes } from './routes/chat';
import { pipelineRoutes } from './routes/pipelines';
import { webhookRoutes } from './routes/webhooks';
import { whatsappWebhookRoutes } from './routes/whatsapp-webhook';
import { teamsWebhookRoutes } from './routes/teams-webhook';
import { webhookIncomingRoutes } from './routes/webhook-incoming';
import { mcpRoutes } from './routes/mcp';
import { toolRoutes } from './routes/tools';
import { voiceRoutes } from './routes/voice';
import { notificationRoutes } from './routes/notifications';
import { workspaceRoutes } from './routes/workspace';
import { oauthRoutes } from './routes/oauth';
import { settingsRoutes } from './routes/settings';
import { expertRoutes } from './routes/experts';
import { skillRoutes } from './routes/skills';
import { recurringTaskRoutes } from './routes/recurring-tasks';
import { evalRoutes } from './routes/eval';
import { evaluationRoutes } from './routes/evaluations';
import { documentRoutes } from './routes/documents';
import { knowledgeRoutes } from './routes/knowledge';
import { pluginRoutes } from './routes/plugins';
import { searchRoutes } from './routes/search';
import { deviceRoutes } from './routes/devices';
import { authGuard } from './middleware/auth-guard';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { setupWebSocket } from './websocket';
import { setupGatewayWebSocket } from './gateway-ws';
import { gatewayRoutes } from './routes/gateway';

export function createServer() {
  const config = getConfig();

  const app = new Elysia()
    // Swagger documentation
    .use(
      swagger({
        documentation: {
          info: {
            title: 'Assistant API',
            version: '1.0.0',
            description: 'Autonomous Development Assistant API',
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
    .derive(async ({ request, set }) => {
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
        return { user: null, session: null };
      }
      const session = await sessionManager.validate(token);

      if (!session) {
        // Fallback: validate against MASTER_KEY for API/MCP access
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
            return {
              user: { id: adminUser.id, username: adminUser.username, isAdmin: true },
              session: null,
            };
          }
          // Fallback if no admin user exists yet
          return {
            user: { id: 'system', username: 'system', isAdmin: true },
            session: null,
          };
        }
        return { user: null, session: null };
      }

      return {
        user: {
          id: session.userId,
          username: session.username,
          isAdmin: session.isAdmin,
        },
        session,
      };
    })
    // Rate limiting on auth endpoints (must be before routes)
    .use(rateLimitMiddleware)
    // Auth guard — reject unauthenticated requests to protected routes
    .use(authGuard)
    // Routes
    .group('/api', (app) =>
      app
        .use(healthRoutes)
        .use(authRoutes)
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
