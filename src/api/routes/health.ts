import { cliExecutableHealth } from '@/core/cli-executable';
import { Elysia } from '@/api/http';
import { adminDenied } from '@/api/admin-guard';
import { apiContext } from '@/api/context';
import { getUMI } from '@/channels/interface';
import { getGateway } from '@/core/gateway';
import { checkDbHealth } from '@/db/postgres';
import { checkCacheHealth } from '@/db/cache';
import { getAppVersion } from '@/utils/version';
import { getHealthChecker } from '@/models/health-checker';
import { getModelRegistry } from '@/models/model-registry';
import { getProviderRouter } from '@/models/providers';
import { isAdmin } from '@/security/principal';
import { apiLogger } from '@/utils/logger';

/**
 * Public here: `/`, `/live`, `/ready`, `/database` and `/storage` (monitoring,
 * load balancers, k8s probes — auth-guard.ts lists them). Everything else is
 * install state: `/detailed`, `/models`, `/channels` and `/features` are for
 * an admin, `/time` and `/browser-bridge` for anyone signed in.
 */
export const healthRoutes = new Elysia({ prefix: '/health' })
  .use(apiContext)
  // Basic health check
  .get('/', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  })

  // Detailed health check — requires authentication to avoid leaking
  // infrastructure info. The per-service breakdown is for an admin; anyone
  // else gets whether it runs and which build answers.
  .get('/detailed', async ({ user, principal, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }
    if (!isAdmin(principal)) {
      return { status: getGateway().isRunning() ? 'ok' : 'degraded', version: getAppVersion() };
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
        // Which build is actually answering. An operator comparing a bug report
        // against a release had no way to ask, and "the version in the repo I
        // deployed from" is a guess, not a reading.
        version: getAppVersion(),
        state: status.state,
        uptime: status.uptime,
        startedAt: status.startedAt,
        agents: {
          total: status.agents.length,
          running: status.agents.filter((a) => a.status === 'running').length,
        },
        cliExecutables: cliExecutableHealth(),
        health: {
          database: status.health.database,
          storage: status.health.storage,
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
          storage: fallback('storage'),
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
    // Public route: the raw error (hosts, driver messages) goes to the log only.
    if (result.error) apiLogger.warn({ error: result.error }, 'database health check failed');

    return {
      service: 'database',
      status: result.healthy ? 'healthy' : 'unhealthy',
      latency: result.latency,
    };
  })

  // Storage-provider health — Postgres in external mode, the in-process map in
  // embedded. Never Valkey/Redis: that backend was replaced during the Node
  // migration, so a route named for it reported on something the product no
  // longer runs.
  .get('/storage', async () => {
    const result = await checkCacheHealth();
    // Public route: the raw error (hosts, driver messages) goes to the log only.
    if (result.error) apiLogger.warn({ error: result.error }, 'storage health check failed');

    return {
      service: 'storage',
      status: result.healthy ? 'healthy' : 'unhealthy',
      latency: result.latency,
    };
  })

  // Model providers health
  .get('/models', async ({ user, principal, set }) => {
    const denied = adminDenied({ set, user, principal });
    if (denied) return denied;
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
    const storageHealth = await checkCacheHealth();

    if (!dbHealth.healthy || !storageHealth.healthy) {
      return new Response(
        JSON.stringify({ ready: false, database: dbHealth.healthy, storage: storageHealth.healthy }),
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
  .get('/time', async ({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }
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
  .get('/browser-bridge', async ({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }
    try {
      const { getBrowserBridge } = await import('@/api/browser-bridge');
      const bridge = getBrowserBridge();
      return { connected: bridge.connected };
    } catch {
      return { connected: false };
    }
  })

  // Channel status
  .get('/channels', async ({ user, principal, set }) => {
    const denied = adminDenied({ set, user, principal });
    if (denied) return denied;
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
  .get('/features', async ({ user, principal, set }) => {
    const denied = adminDenied({ set, user, principal });
    if (denied) return denied;
    // Text lanes resolve to their own binding; the root runs on the default
    // model. Media rows report what EFFECTIVELY serves them (the media
    // resolver: a lane, or the default model where that counts), and every
    // row but chat is optional (docs/MODULES.md → Capability gates).
    const FEATURE_TOPICS = [
      { key: 'chat', name: 'Chat', topic: 'general', required: true,
        help: 'The base chat brain — every message that is not delegated runs on your default model. The only thing Octipus requires.',
        hint: 'Add a model and set it as the default' },
      { key: 'build', name: 'Build', topic: 'build', required: false,
        help: 'Implementation, architecture, debugging and review work. Workers on this lane fail loud while it is unbound.',
        hint: "Assign a model to the 'build' topic" },
      { key: 'everyday', name: 'Everyday', topic: 'everyday', required: false,
        help: 'Chat, lookups, summaries, drafting: high volume, low stakes.',
        hint: "Assign a fast, cheap model to the 'everyday' topic" },
      { key: 'verify', name: 'Verify', topic: 'verify', required: false,
        help: 'Review and QA — best a different model from the one that did the work. Unbound: falls back to build.',
        hint: "Assign a model to the 'verify' topic" },
      { key: 'research', name: 'Research', topic: 'research', required: false,
        help: 'Investigation and deep research — the highest-token work. Research fails loud if this is unbound.',
        hint: "Assign a (local/cheap) model to the 'research' topic" },
      { key: 'background', name: 'Background tasks', topic: 'background', required: false,
        help: 'Memory extraction, knowledge-base review, evaluation, chunk summaries, tool-call translation. Without it these features are skipped.',
        hint: "Assign a (cheap/local) model to the 'background' topic" },
      { key: 'embedding', name: 'Search & memory (embeddings)', topic: 'embedding', required: false,
        help: 'Knowledge-base indexing, semantic search and memory. Without one these features are off (not broken); content saved meanwhile is indexed once one is added.',
        hint: "Assign an embedding model to the 'embedding' topic" },
      { key: 'vision', name: 'Reading images', topic: 'vision', required: false, need: 'see',
        help: 'A model that reads images itself gets them directly. This row shows what reads images for models that cannot: the Vision lane, else the default model if it reads images.',
        hint: "Use a default model that reads images, or assign one to the 'vision' topic" },
      { key: 'ocr', name: 'Scanned documents (OCR)', topic: 'ocr', required: false, need: 'ocr',
        help: 'Extracts text from scanned PDFs and images: the OCR lane, else Vision, else the default model if it reads images.',
        hint: "Assign an OCR model (e.g. DeepSeek-OCR, GLM-OCR) to the 'ocr' topic" },
      { key: 'image_generation', name: 'Image generation', topic: 'image_generation', required: false, need: 'draw',
        help: 'Creates and edits images (generate_image). Without it the tool is not offered.',
        hint: "Assign an image model to the 'image_generation' topic" },
      { key: 'transcription', name: 'Speech to text', topic: 'transcription', required: false, need: 'hear',
        help: 'Voice notes, the microphone, phone calls and transcribe_audio. Without it voice input is off.',
        hint: "Assign a transcription model or local engine to the 'transcription' topic" },
      { key: 'speech', name: 'Text to speech', topic: 'speech', required: false, need: 'speak',
        help: 'Spoken replies, phone calls and speak. Without it spoken output is off.',
        hint: "Assign a speech model or local engine to the 'speech' topic" },
    ] as const;

    const registry = getModelRegistry();
    const defaultModel = await registry.getDefaultModel();
    const { resolveMedia } = await import('@/models/media-resolver');

    const features = await Promise.all(
      FEATURE_TOPICS.map(async (feature) => {
        const { key, name, topic, required, help, hint } = feature;
        try {
          if (topic === 'general') {
            const configured = !!defaultModel;
            return { key, name, topic, required, help, configured, model: configured ? defaultModel!.name : null, ...(configured ? {} : { hint }) };
          }
          if ('need' in feature) {
            const resolution = await resolveMedia(feature.need);
            if (resolution.mode !== 'none') {
              const model = resolution.mode === 'lane' && resolution.lane === 'default' ? `${resolution.row.name} (default model)` : resolution.row.name;
              return { key, name, topic, required, help, configured: true, model };
            }
            return { key, name, topic, required, help, configured: false, model: null, hint };
          }
          const model = await registry.getModelForTopic(topic);
          const configured = !!model;
          // The local embedding engine: whether it is installed, running, crashing.
          const engine = model?.provider === 'local-engine'
            ? await (async () => {
              const { localEngineStatus, isModelInstalled } = await import('@/capabilities/local-engine/engine-process');
              const { localEmbeddingModel } = await import('@/capabilities/local-engine/manifest');
              const entry = localEmbeddingModel(model.modelId);
              return { ...localEngineStatus(), installed: !!entry && isModelInstalled(entry) };
            })()
            : undefined;
          return { key, name, topic, required, help, configured, model: configured ? model!.name : null, ...(engine ? { localEngine: engine } : {}), ...(configured ? {} : { hint }) };
        } catch {
          return { key, name, topic, required, help, configured: false, model: null, hint };
        }
      }),
    );

    return { features };
  });
