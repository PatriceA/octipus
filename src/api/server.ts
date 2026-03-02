import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';
import { getConfig } from '@/config';
import { apiLogger } from '@/utils/logger';
import { getSessionManager } from '@/security/auth/session';

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
import { skillRoutes } from './routes/skills';
import { voiceRoutes } from './routes/voice';
import { notificationRoutes } from './routes/notifications';
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
        credentials: true,
      })
    )
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
        .use(skillRoutes)
        .use(voiceRoutes)
        .use(notificationRoutes)
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
