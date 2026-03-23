import { Elysia } from 'elysia';
import { getGateway } from '@/core/gateway';
import { checkDbHealth } from '@/db/postgres';
import { checkRedisHealth } from '@/db/redis';
import { checkStorageHealth } from '@/db/storage';
import { getHealthChecker } from '@/models/health-checker';
import { getUMI } from '@/channels/interface';
import { getModelRegistry } from '@/models/model-registry';

export const healthRoutes = new Elysia({ prefix: '/health' })
  // Basic health check
  .get('/', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  })

  // Detailed health check — requires authentication to avoid leaking infrastructure info
  .get('/detailed', async (ctx: any) => {
    if (!ctx.user) {
      ctx.set.status = 401;
      return { error: 'Authentication required' };
    }
    try {
      const gateway = getGateway();
      const status = await gateway.getStatus();
      const healthChecker = getHealthChecker();

      // Get real service health for LiteLLM (Ollama is proxied through LiteLLM)
      let litellm: { status: string; latency?: number; message?: string; lastChecked?: Date };
      try {
        litellm = await healthChecker.checkLiteLLMProxy();
      } catch (e) {
        litellm = {
          status: 'unhealthy',
          message: (e as Error).message,
          lastChecked: new Date(),
        };
      }

      return {
        status: status.state === 'running' ? 'ok' : 'degraded',
        state: status.state,
        uptime: status.uptime,
        startedAt: status.startedAt,
        agents: {
          total: status.agents.length,
          running: status.agents.filter((a) => a.status === 'running').length,
        },
        health: {
          database: status.health.database,
          redis: status.health.redis,
          litellm: {
            service: 'litellm',
            status: litellm.status,
            latency: litellm.latency,
            message: litellm.message,
            lastChecked: litellm.lastChecked,
          },
        },
      };
    } catch (error) {
      // Fallback — never return empty response
      return {
        status: 'error',
        state: 'unknown',
        uptime: 0,
        agents: { total: 0, running: 0 },
        health: {
          database: { service: 'database', status: 'unhealthy', message: 'Health check failed', lastChecked: new Date() },
          redis: { service: 'redis', status: 'unhealthy', message: 'Health check failed', lastChecked: new Date() },
          litellm: { service: 'litellm', status: 'unhealthy', message: 'Health check failed', lastChecked: new Date() },
        },
      };
    }
  })

  // Database health
  .get('/database', async () => {
    const result = await checkDbHealth();

    return {
      service: 'database',
      status: result.healthy ? 'healthy' : 'unhealthy',
      latency: result.latency,
      error: result.error,
    };
  })

  // Redis health
  .get('/redis', async () => {
    const result = await checkRedisHealth();

    return {
      service: 'redis',
      status: result.healthy ? 'healthy' : 'unhealthy',
      latency: result.latency,
      error: result.error,
    };
  })

  // Model providers health
  .get('/models', async () => {
    const healthChecker = getHealthChecker();
    const providers = await healthChecker.checkAllProviders();

    return {
      providers: providers.map((p) => ({
        provider: p.provider,
        status: p.status,
        latency: p.latency,
        models: p.models.length,
        lastChecked: p.lastChecked,
      })),
    };
  })

  // Readiness probe (for Kubernetes)
  .get('/ready', async () => {
    const dbHealth = await checkDbHealth();
    const redisHealth = await checkRedisHealth();

    if (!dbHealth.healthy || !redisHealth.healthy) {
      return new Response(
        JSON.stringify({ ready: false, database: dbHealth.healthy, redis: redisHealth.healthy }),
        { status: 503 }
      );
    }

    return { ready: true };
  })

  // Liveness probe (for Kubernetes)
  .get('/live', async () => {
    const gateway = getGateway();
    const isRunning = gateway.isRunning();

    if (!isRunning) {
      return new Response(JSON.stringify({ live: false }), { status: 503 });
    }

    return { live: true };
  })

  // Channel status
  .get('/channels', async () => {
    try {
      const umi = getUMI();
      const allChannels = umi.getAllChannels();

      return {
        channels: allChannels.map((ch) => ({
          type: ch.type,
          name: ch.name,
          connected: ch.isConnected(),
        })),
      };
    } catch {
      return { channels: [] };
    }
  })

  // Feature status — checks which features have models configured via topic routing
  .get('/features', async () => {
    const FEATURE_TOPICS = [
      { name: 'Chat & Orchestration', topic: 'general', hint: 'Add a model and set it as default' },
      { name: 'Code Generation', topic: 'coding', hint: "Assign a model to the 'coding' topic" },
      { name: 'Knowledge Base (RAG)', topic: 'embedding', hint: "Pull nomic-embed-text on Ollama and assign 'embedding' topic" },
      { name: 'Document OCR', topic: 'vision', hint: "Pull a vision model (e.g., glm-ocr) and assign 'vision' topic" },
      { name: 'Research & Analysis', topic: 'analysis', hint: "Assign a model to the 'analysis' topic" },
    ] as const;

    const registry = getModelRegistry();

    const features = await Promise.all(
      FEATURE_TOPICS.map(async ({ name, topic, hint }) => {
        try {
          const model = await registry.getModelForTopic(topic);
          // getModelForTopic falls back to default model. For specialist topics
          // (embedding, vision) that require specific model capabilities, check
          // whether the resolved model actually has the topic in its topics array
          // or topicRoles — otherwise the default model can't fulfill the role.
          const specialistTopics = ['embedding', 'vision'];
          let isExplicit = true;
          if (model && specialistTopics.includes(topic)) {
            const hasTopic = model.topics?.includes(topic);
            const hasTopicRole = model.topicRoles && topic in model.topicRoles;
            isExplicit = !!(hasTopic || hasTopicRole);
          }

          const configured = !!(model && isExplicit);
          return {
            name,
            topic,
            configured,
            model: configured ? model!.name : null,
            ...(configured ? {} : { hint }),
          };
        } catch {
          return { name, topic, configured: false, model: null, hint };
        }
      }),
    );

    return { features };
  });
