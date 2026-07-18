import { Elysia } from 'elysia';
import { getUMI } from '@/channels/interface';
import { getConfig } from '@/config';
import { getGateway } from '@/core/gateway';
import { describeMode, resolveOrchestratorMode } from '@/core/orchestrator/mode-selector';
import { checkDbHealth } from '@/db/postgres';
import { checkRedisHealth } from '@/db/redis';
import { getHealthChecker } from '@/models/health-checker';
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

      const directCheck = (name: string) => {
        const p = providerByName(name);
        if (!p) {
          return Promise.resolve({
            service: name, status: 'not_configured' as const, message: 'Provider not registered', lastChecked: new Date(),
          });
        }
        return healthChecker.checkDirectProvider(name, p).catch((e: Error) => ({
          service: name, status: 'not_configured' as const, message: e.message, lastChecked: new Date(),
        }));
      };

      /**
       * Health probe for custom-* providers. Custom endpoints don't expose a
       * uniform health/models route, so we just verify TCP/TLS reachability:
       * any HTTP response (incl. 4xx) means the host is up and routable.
       * Only network errors (DNS, refused, timeout) mark the endpoint unhealthy.
       *
       * Probes each unique base URL across all configured custom-openai /
       * custom-anthropic / custom-gemini models (so multiple models on the same
       * host aren't probed N times).
       */
      const customCheck = async () => {
        try {
          const registry = getModelRegistry();
          const models = await registry.getAllModels();
          const customModels = models.filter(
            (m) => m.provider.startsWith('custom-') && m.endpoint,
          );
          if (customModels.length === 0) {
            return { service: 'custom', status: 'not_configured' as const, message: 'No custom endpoints registered', lastChecked: new Date() };
          }

          const uniqueBases = Array.from(new Set(customModels.map((m) => m.endpoint!.replace(/\/+$/, ''))));
          const start = Date.now();
          const probes = await Promise.allSettled(
            uniqueBases.map(async (base) => {
              const res = await fetch(base, { method: 'HEAD', signal: AbortSignal.timeout(5000), redirect: 'manual' })
                .catch(() => fetch(base, { method: 'GET', signal: AbortSignal.timeout(5000), redirect: 'manual' }));
              return { base, ok: !!res, status: res?.status };
            }),
          );

          const reachable = probes.filter((p) => p.status === 'fulfilled' && p.value.ok).length;
          const total = uniqueBases.length;
          const allReachable = reachable === total;
          const noneReachable = reachable === 0;

          return {
            service: 'custom',
            status: allReachable ? ('healthy' as const) : noneReachable ? ('unhealthy' as const) : ('degraded' as const),
            latency: Date.now() - start,
            message: `${reachable}/${total} endpoint${total === 1 ? '' : 's'} reachable (${customModels.length} model${customModels.length === 1 ? '' : 's'})`,
            lastChecked: new Date(),
          };
        } catch (e) {
          return { service: 'custom', status: 'unhealthy' as const, message: (e as Error).message, lastChecked: new Date() };
        }
      };

      // Scheduler liveness: the task-queue worker loop writes a heartbeat each
      // tick. A stale/absent heartbeat means it's wedged or never started.
      const schedulerCheck = async () => {
        try {
          const { getScheduler } = await import('@/core/scheduler');
          const stats = await getScheduler().getStats();
          if (!stats.heartbeat) {
            return { service: 'scheduler', status: 'not_configured' as const, message: 'worker loop not started', lastChecked: new Date() };
          }
          return {
            service: 'scheduler',
            status: stats.heartbeat.stale ? ('unhealthy' as const) : ('healthy' as const),
            message: stats.heartbeat.stale
              ? `heartbeat stale (${Math.round(stats.heartbeat.ageMs / 1000)}s)`
              : `queue ${stats.queueLength}, processing ${stats.processing}`,
            lastChecked: new Date(),
          };
        } catch (e) {
          return { service: 'scheduler', status: 'unhealthy' as const, message: (e as Error).message, lastChecked: new Date() };
        }
      };

      // Probe every direct provider. checkHealth() short-circuits to "not
      // configured" (no network call) when no API key is set, so this doesn't
      // burn paid calls for unused providers — a configured key, not a native
      // model row, is what marks a provider as in-use. Gating on model rows
      // wrongly greyed out providers whose models route through the litellm
      // proxy (provider !== the direct name) despite a key being set.
      const [litellm, ollama, openai, anthropic, gemini, deepseek, grok, mistral, zai, moonshot, voyage, openrouter, vertex, custom, scheduler] = await Promise.all([
        healthChecker.checkLiteLLMProxy().catch((e: Error) => ({
          service: 'litellm', status: 'unhealthy' as const, message: e.message, lastChecked: new Date(),
        })),
        healthChecker.checkOllama().catch((e: Error) => ({
          service: 'ollama', status: 'unhealthy' as const, message: e.message, lastChecked: new Date(),
        })),
        directCheck('openai'),
        directCheck('anthropic'),
        directCheck('gemini'),
        directCheck('deepseek'),
        directCheck('grok'),
        directCheck('mistral'),
        directCheck('zai'),
        directCheck('moonshot'),
        directCheck('voyage'),
        directCheck('openrouter'),
        directCheck('vertex'),
        customCheck(),
        schedulerCheck(),
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
          grok: toHealthEntry(grok),
          mistral: toHealthEntry(mistral),
          zai: toHealthEntry(zai),
          moonshot: toHealthEntry(moonshot),
          voyage: toHealthEntry(voyage),
          openrouter: toHealthEntry(openrouter),
          vertex: toHealthEntry(vertex),
          custom: toHealthEntry(custom),
          scheduler: toHealthEntry(scheduler),
        },
      };
    } catch (_error) {
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
          grok: fallback('grok'),
          mistral: fallback('mistral'),
          zai: fallback('zai'),
          moonshot: fallback('moonshot'),
          voyage: fallback('voyage'),
          openrouter: fallback('openrouter'),
          custom: fallback('custom'),
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

  // Valkey (Redis-compatible) health. Route + JSON key stay `redis` — it's a
  // stable API contract the web dashboard and external monitoring read.
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

  // Browser extension bridge status — `octi doctor` queries this to
  // detect store-installed extensions (which don't drop a copy under
  // ~/.octipus). Returns `{ connected: true }` only when a browser
  // is actively holding the bridge WS open.
  .get('/browser-bridge', async () => {
    try {
      const { getBrowserBridge } = await import('@/api/browser-bridge');
      const bridge = getBrowserBridge();
      return { connected: bridge.connected };
    } catch {
      return { connected: false };
    }
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

  // Feature status — which features have a model bound to the topic they
  // depend on. Each entry carries `required` (a hard dependency that throws if
  // unbound vs. a soft one that falls back to the default model) and `help`
  // (hover text explaining the feature). Only topics a feature actually depends
  // on are listed. OCR and Vision are separate rows (distinct models/roles).
  .get('/features', async () => {
    const FEATURE_TOPICS = [
      { key: 'chat', name: 'Chat', topic: 'general', required: true,
        help: 'The base chat brain — every message that is not delegated runs on your default model.',
        hint: 'Add a model and set it as the default' },
      { key: 'orchestration', name: 'Orchestration', topic: 'general', required: true,
        help: 'The swarm orchestrator that routes work to specialist agents. Its depth (Router/Light/Full) follows the default model size.',
        hint: 'Set a default model — orchestration runs on it' },
      { key: 'agents', name: 'Specialist agents', topic: 'agents', required: true,
        help: 'The model lane every specialist/expert worker (Coder, custom experts, …) resolves from. Workers fail loud if unbound.',
        hint: "Assign a model to the 'agents' topic" },
      { key: 'writing', name: 'Writing (long-form text roles)', topic: 'writing', required: false,
        help: 'The model lane for the Researcher, Writer, Project Manager and Communication roles — split from Agents so they can run on a cheaper/faster model. Those roles fail loud if this is unbound.',
        hint: "Assign a model to the 'writing' topic (or rebind those roles to 'agents')" },
      { key: 'embedding', name: 'Knowledge base (embeddings)', topic: 'embedding', required: true,
        help: 'Embeddings power knowledge-base indexing and semantic search. Required for RAG.',
        hint: "Assign the 'embedding' topic to an embedding model" },
      { key: 'background', name: 'Background tasks', topic: 'background', required: false,
        help: 'Memory extraction, knowledge-base review, evaluation, chunk summaries, tool-call translation. Optional — without it these features are skipped.',
        hint: "Assign a (cheap/local) model to the 'background' topic" },
      { key: 'ocr', name: 'Document OCR', topic: 'ocr', required: false,
        help: 'Extracts text from scanned PDFs and images. Falls back to the Vision model if unset.',
        hint: "Assign an OCR model (e.g. glm-ocr) to the 'ocr' topic" },
      { key: 'vision', name: 'Image vision', topic: 'vision', required: false,
        help: 'Describes image attachments and is the fallback for OCR.',
        hint: "Assign a vision model to the 'vision' topic" },
      { key: 'voice', name: 'Voice calls', topic: 'voice', required: false,
        help: 'Phone-call conversations (Twilio/Telnyx/Plivo). Optional — falls back to the default model if unset.',
        hint: "Assign a fast model to the 'voice' topic" },
    ] as const;

    const registry = getModelRegistry();
    // Chat and Orchestration run on the *default* model: the orchestrator and
    // router resolve via getDefaultModel(), and getModelForTopic() has no
    // default fallback. So a 'general' binding is NOT what makes them work —
    // resolve those rows against the default instead of the topic.
    const defaultModel = await registry.getDefaultModel();

    // A model "explicitly" serves a specialist topic only when it carries that
    // topic (legacy array or topicRoles) — the default model can't stand in.
    const isExplicit = (
      model: Awaited<ReturnType<typeof registry.getModelForTopic>>,
      topic: string,
    ): boolean => !!(model && (model.topics?.includes(topic) || (model.topicRoles && topic in model.topicRoles)));

    const SPECIALIST_TOPICS = ['embedding', 'vision', 'ocr'];

    const features = await Promise.all(
      FEATURE_TOPICS.map(async ({ key, name, topic, required, help, hint }) => {
        try {
          if (topic === 'general') {
            const configured = !!defaultModel;
            return {
              key, name, topic, required, help, configured,
              model: configured ? defaultModel!.name : null,
              ...(configured ? {} : { hint }),
            };
          }

          const model = await registry.getModelForTopic(topic);
          const explicit = SPECIALIST_TOPICS.includes(topic) ? isExplicit(model, topic) : !!model;
          let configured = !!(model && explicit);
          let resolvedModel = configured ? model!.name : null;

          // The document processor falls OCR back to the vision model, so OCR
          // is functional whenever either 'ocr' or 'vision' is explicitly bound.
          if (key === 'ocr' && !configured) {
            const vision = await registry.getModelForTopic('vision');
            if (isExplicit(vision, 'vision')) {
              configured = true;
              resolvedModel = `${vision!.name} (via vision)`;
            }
          }

          return {
            key, name, topic, required, help, configured,
            model: resolvedModel,
            ...(configured ? {} : { hint }),
          };
        } catch {
          return { key, name, topic, required, help, configured: false, model: null, hint };
        }
      }),
    );

    return { features };
  })

  // Orchestrator run-mode — router / lite / full, derived from the default
  // model's size and the configured thresholds (same logic the runtime uses
  // each turn). Surfaced so the web header and TUI can always show how Octipus
  // is running. Returns mode=null when no default model is set yet.
  .get('/orchestrator', async () => {
    const orch = getConfig().orchestrator;
    const registry = getModelRegistry();
    const model = await registry.getDefaultModel();
    if (!model) {
      return { mode: null, label: null, description: 'No default model set' };
    }
    const mode = resolveOrchestratorMode(
      { modelId: model.modelId, metadata: model.metadata, provider: model.provider },
      {
        mode: orch.mode,
        routerSmallModelMaxParams: orch.routerSmallModelMaxParams,
        liteModelMaxParams: orch.liteModelMaxParams,
      },
    );
    // Display labels — 'lite' surfaces as "Light" per product naming; the raw
    // `mode` id stays the canonical value for any programmatic consumer. This
    // route is public (like the other /health routes) so it deliberately does
    // NOT echo the model name — that would leak infra info to anonymous callers
    // (cf. /health/detailed, which is auth-gated for the same reason).
    const LABELS = { router: 'Router', lite: 'Light', full: 'Full' } as const;
    return { mode, label: LABELS[mode], description: describeMode(mode) };
  });
