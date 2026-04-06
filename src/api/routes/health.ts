import { Elysia } from 'elysia';
import { getGateway } from '@/core/gateway';
import { checkDbHealth } from '@/db/postgres';
import { checkRedisHealth } from '@/db/redis';
import { checkStorageHealth } from '@/db/storage';
import { getHealthChecker } from '@/models/health-checker';
import { getUMI } from '@/channels/interface';
import { getModelRegistry } from '@/models/model-registry';
import { getProviderRouter } from '@/models/providers';

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

      // Check all service health in parallel
      const router = getProviderRouter();
      const allProviders = router.getAllProviders();
      const providerByName = (name: string) => allProviders.find(p => p.name === name);

      const [litellm, ollama, openai, anthropic, gemini, deepseek] = await Promise.all([
        healthChecker.checkLiteLLMProxy().catch((e: Error) => ({
          service: 'litellm', status: 'unhealthy' as const, message: e.message, lastChecked: new Date(),
        })),
        healthChecker.checkOllama().catch((e: Error) => ({
          service: 'ollama', status: 'unhealthy' as const, message: e.message, lastChecked: new Date(),
        })),
        healthChecker.checkDirectProvider('openai', providerByName('openai')!).catch((e: Error) => ({
          service: 'openai', status: 'not_configured' as const, message: e.message, lastChecked: new Date(),
        })),
        healthChecker.checkDirectProvider('anthropic', providerByName('anthropic')!).catch((e: Error) => ({
          service: 'anthropic', status: 'not_configured' as const, message: e.message, lastChecked: new Date(),
        })),
        healthChecker.checkDirectProvider('gemini', providerByName('gemini')!).catch((e: Error) => ({
          service: 'gemini', status: 'not_configured' as const, message: e.message, lastChecked: new Date(),
        })),
        healthChecker.checkDirectProvider('deepseek', providerByName('deepseek')!).catch((e: Error) => ({
          service: 'deepseek', status: 'not_configured' as const, message: e.message, lastChecked: new Date(),
        })),
      ]);

      const toHealthEntry = (h: { service?: string; status: string; latency?: number; message?: string; lastChecked?: Date }) => ({
        service: h.service,
        status: h.status,
        latency: h.latency,
        message: h.message,
        lastChecked: h.lastChecked,
      });

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
          litellm: toHealthEntry(litellm),
          ollama: toHealthEntry(ollama),
          openai: toHealthEntry(openai),
          anthropic: toHealthEntry(anthropic),
          gemini: toHealthEntry(gemini),
          deepseek: toHealthEntry(deepseek),
        },
      };
    } catch (error) {
      // Fallback — never return empty response
      const fallback = (svc: string) => ({ service: svc, status: 'unhealthy', message: 'Health check failed', lastChecked: new Date() });
      return {
        status: 'error',
        state: 'unknown',
        uptime: 0,
        agents: { total: 0, running: 0 },
        health: {
          database: fallback('database'),
          redis: fallback('redis'),
          litellm: fallback('litellm'),
          ollama: fallback('ollama'),
          openai: fallback('openai'),
          anthropic: fallback('anthropic'),
          gemini: fallback('gemini'),
          deepseek: fallback('deepseek'),
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

  // Server time and timezone — for schedule/calendar UI to show server context
  .get('/time', async () => {
    const now = new Date();
    return {
      serverTime: now.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      utcOffset: -now.getTimezoneOffset(),
    };
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
      { name: 'Knowledge Base (RAG)', topic: 'embedding', hint: "Assign the 'embedding' topic to an embedding model" },
      { name: 'Document OCR', topic: 'vision', hint: "Pull a vision model (e.g., glm-ocr) and assign 'vision' topic" },
      { name: 'Research & Analysis', topic: 'analysis', hint: "Assign a model to the 'analysis' topic" },
      { name: 'Architecture', topic: 'architecture', hint: "Assign a model to the 'architecture' topic" },
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
