import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';
import { getConfig } from '@/config';
import { apiLogger } from '@/utils/logger';
import { getSessionManager } from '@/security/auth/session';
import { secureCompare } from '@/utils/crypto';

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
import { authGuard } from './middleware/auth-guard';
import { setupWebSocket } from './websocket';

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
    })
    // Request logging
    .onRequest(({ request }) => {
      apiLogger.debug({ method: request.method, url: request.url }, 'Request received');
    })
    // Error handling
    .onError(({ error, code }) => {
      apiLogger.error({ error, code }, 'Request error');

      if (code === 'VALIDATION') {
        return { error: 'Validation error', details: error.message };
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

      if (!authHeader?.startsWith('Bearer ')) {
        return { user: null, session: null };
      }

      const token = authHeader.substring(7);
      const session = await sessionManager.validate(token);

      if (!session) {
        // Fallback: validate against MASTER_KEY for API/MCP access
        const masterKey = process.env.MASTER_KEY;
        if (masterKey && secureCompare(token, masterKey)) {
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
    );

  // Webhooks — unauthenticated, outside /api group
  app.group('/api', (app) => app.use(webhookRoutes));

  // WebSocket setup
  setupWebSocket(app as any);

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
