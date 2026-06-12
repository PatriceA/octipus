import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getConfig } from '@/config';
import type { NewModelConfigEntry } from '@/db/schema/models';
import { getCapabilitiesForModel } from '@/models/capabilities';
import { getCostTracker } from '@/models/cost-tracker';
import { getHealthChecker } from '@/models/health-checker';
import { getModelRegistry } from '@/models/model-registry';
import { getProviderRouter } from '@/models/providers';
import type { DeepSeekProvider } from '@/models/providers/deepseek-provider';
import { getQuotaTracker } from '@/models/quota-tracker';
import { coreLogger } from '@/utils/logger';
import { fetchGuarded } from '@/utils/sanitize';

/**
 * Resolve a custom-provider API key from an apiKeyRef.
 * Mirrors BaseCustomProvider.resolveApiKey but used at the API layer
 * for the test-model endpoint (where the provider hasn't been called yet).
 *
 * Lookup order: env: prefix → user's vault → system vault.
 */
async function resolveCustomApiKey(
  apiKeyRef: string | undefined,
  userId?: string,
): Promise<string | null> {
  if (!apiKeyRef) return null;
  if (apiKeyRef.startsWith('env:')) {
    return process.env[apiKeyRef.slice(4)] || null;
  }
  try {
    const { getVault } = await import('@/security/vault');
    const vault = getVault();
    if (userId && userId !== 'system') {
      const v = await vault.getByName(userId, apiKeyRef);
      if (v) return v;
    }
    return (await vault.getByName('system', apiKeyRef)) || null;
  } catch {
    return null;
  }
}

// ── OpenRouter live model search cache ──────────────────────────────
interface OpenRouterApiModel {
  id: string;
  name: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
  top_provider?: { max_completion_tokens?: number };
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
}

let openRouterModelCache: { data: OpenRouterApiModel[]; fetchedAt: number } | null = null;
const OPENROUTER_CACHE_TTL = 300_000; // 5 minutes

async function fetchOpenRouterModels(apiKey: string): Promise<OpenRouterApiModel[]> {
  // Return cached data if still fresh
  if (openRouterModelCache && Date.now() - openRouterModelCache.fetchedAt < OPENROUTER_CACHE_TTL) {
    return openRouterModelCache.data;
  }

  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter API returned ${res.status}`);
  }

  const json = await res.json() as { data: OpenRouterApiModel[] };
  openRouterModelCache = { data: json.data || [], fetchedAt: Date.now() };
  return openRouterModelCache.data;
}

function mapOpenRouterModel(m: OpenRouterApiModel) {
  const promptPrice = parseFloat(m.pricing?.prompt || '0');
  const completionPrice = parseFloat(m.pricing?.completion || '0');
  const inputModalities = m.architecture?.input_modalities || [];
  const outputModalities = m.architecture?.output_modalities || [];

  return {
    id: m.id,
    label: m.name,
    contextWindow: m.context_length || 0,
    maxOutputTokens: m.top_provider?.max_completion_tokens || undefined,
    // Convert per-token pricing to per-1M-tokens
    costPerInputToken: +(promptPrice * 1_000_000).toFixed(2),
    costPerOutputToken: +(completionPrice * 1_000_000).toFixed(2),
    supportsVision: inputModalities.includes('image'),
    supportsTools: outputModalities.includes('text'), // most text-output models support tools
  };
}


export const modelRoutes = new Elysia({ prefix: '/models' })
  .use(apiContext)
  // List all models
  .get(
    '/',
    async ({ user }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const registry = getModelRegistry();
      const models = user.isAdmin
        ? await registry.getAllModelsIncludeDisabled()
        : await registry.getModelsForUser(user.id);

      return {
        models: models.map((m) => ({
          id: m.id,
          name: m.name,
          provider: m.provider,
          modelId: m.modelId,
          endpoint: m.endpoint,
          apiKeyRef: m.apiKeyRef,
          maxTokens: m.maxTokens,
          contextWindow: m.contextWindow,
          supportsVision: m.supportsVision,
          supportsTools: m.supportsTools,
          supportsStreaming: m.supportsStreaming,
          topics: m.topics,
          priority: m.priority,
          costPerInputToken: m.costPerInputToken,
          costPerOutputToken: m.costPerOutputToken,
          isEnabled: m.isEnabled,
          isDefault: m.isDefault,
          metadata: m.metadata,
        })),
      };
    },
    { detail: { tags: ['models'] } }
  )

  // Get model by name
  .get(
    '/:name',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const registry = getModelRegistry();
      const model = await registry.getModel(params.name);

      if (!model) {
        return { error: 'Model not found' };
      }

      return {
        ...model,
        capabilities: getCapabilitiesForModel(model),
      };
    },
    {
      params: t.Object({
        name: t.String(),
      }),
      detail: { tags: ['models'] },
    }
  )

  // Test model connection before registering
  .post(
    '/test',
    async ({ user, body }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      const { provider, modelId, endpoint } = body;
      const apiKeyRef = (body as { apiKeyRef?: string }).apiKeyRef;
      const metadata = (body as { metadata?: { customProvider?: import('@/db/schema/models').CustomProviderConfig } }).metadata;

      try {
        if (provider === 'ollama') {
          // For Ollama models proxied through LiteLLM, test via LiteLLM first
          const config = getConfig();
          const litellmBase = config.litellm.proxyUrl || 'http://localhost:4000';
          const litellmKey = config.litellm.apiKey || process.env.LITELLM_MASTER_KEY || '';
          try {
            const litellmModels = await fetch(`${litellmBase}/v1/models`, {
              headers: litellmKey ? { 'Authorization': `Bearer ${litellmKey}` } : {},
              signal: AbortSignal.timeout(3000),
            });
            if (litellmModels.ok) {
              const modelsData = await litellmModels.json();
              const litellmModelIds = (modelsData.data || []).map((m: any) => m.id);
              if (litellmModelIds.includes(modelId)) {
                // Model is in LiteLLM — test via LiteLLM instead of Ollama directly
                const testRes = await fetch(`${litellmBase}/v1/chat/completions`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    ...(litellmKey ? { 'Authorization': `Bearer ${litellmKey}` } : {}),
                  },
                  body: JSON.stringify({
                    model: modelId,
                    messages: [{ role: 'user', content: 'Say ok' }],
                    max_tokens: 5,
                  }),
                });
                if (!testRes.ok) {
                  const errData = await testRes.json().catch(() => ({}));
                  return { success: false, error: errData?.error?.message || `LiteLLM returned ${testRes.status}` };
                }
                const testData = await testRes.json();
                const reply = testData.choices?.[0]?.message?.content || '';
                return { success: true, message: `Model responded via LiteLLM: "${reply.slice(0, 100)}"` };
              }
            }
          } catch {
            // LiteLLM unreachable, fall through to direct Ollama test
          }

          // Test Ollama directly — check if model exists. Fall back order:
          //   1. endpoint from the Add Model dialog (per-model override)
          //   2. global ollama.url from Settings (so the user doesn't have
          //      to re-type the URL in every model dialog)
          //   3. localhost default
          const ollamaBase = endpoint || config.ollama.url || 'http://localhost:11434';
          const tagsRes = await fetch(`${ollamaBase}/api/tags`);
          if (!tagsRes.ok) {
            return { success: false, error: `Cannot reach Ollama at ${ollamaBase}` };
          }
          const tags = await tagsRes.json();
          const models = tags.models?.map((m: { name: string }) => m.name) || [];
          // Match exact name, name:tag prefix, or strip :latest suffix for comparison
          const normalize = (n: string) => n.replace(/:latest$/, '');
          const found = models.some((m: string) =>
            m === modelId ||
            m.startsWith(modelId + ':') ||
            normalize(m) === normalize(modelId)
          );
          if (!found) {
            return {
              success: false,
              error: `Model "${modelId}" not found on Ollama. Available: ${models.join(', ') || 'none'}`,
            };
          }

          // Quick generation test — use the full Ollama model name if available
          const ollamaModel = models.find((m: string) =>
            m === modelId || m.startsWith(modelId + ':') || normalize(m) === normalize(modelId)
          ) || modelId;
          const testRes = await fetch(`${ollamaBase}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: ollamaModel,
              messages: [{ role: 'user', content: 'Say ok' }],
              stream: false,
              options: { num_predict: 5 },
            }),
          });
          if (!testRes.ok) {
            return { success: false, error: `Ollama returned ${testRes.status} when testing model` };
          }
          const testData = await testRes.json();
          const reply = testData.message?.content || '';
          return { success: true, message: `Model responded: "${reply.slice(0, 100)}"` };

        } else if (provider === 'custom-openai' || provider === 'custom-anthropic' || provider === 'custom-gemini') {
          // Custom providers — model row may not exist yet (test happens
          // before save). Resolve API key from apiKeyRef and call the provider
          // with a customProviderOverride so it skips the DB lookup.
          if (!endpoint) {
            return { success: false, error: 'Endpoint URL is required for custom providers' };
          }
          if (!metadata?.customProvider) {
            return { success: false, error: 'metadata.customProvider config is required for custom providers' };
          }

          const apiKey = await resolveCustomApiKey(apiKeyRef, user?.id);
          if (!apiKey) {
            return {
              success: false,
              error: `Could not resolve API key (apiKeyRef='${apiKeyRef ?? '<none>'}'). Use 'env:VAR_NAME' or store in vault.`,
            };
          }

          const router = getProviderRouter();
          const directProvider = router.getAllProviders().find(p => p.name === provider);
          if (!directProvider) {
            return { success: false, error: `Provider '${provider}' not registered` };
          }

          try {
            const result = await directProvider.complete({
              model: modelId,
              messages: [{ role: 'user', content: 'Say ok', timestamp: new Date() }],
              maxTokens: 16,
              temperature: 0,
              customProviderOverride: {
                baseUrl: endpoint,
                apiKey,
                modelId,
                custom: metadata.customProvider,
              },
            });
            const reply = result.content || '';
            return {
              success: true,
              message: `Model responded: "${reply.slice(0, 100)}"`,
            };
          } catch (directErr) {
            return {
              success: false,
              error: `Direct ${provider} test failed: ${(directErr as Error).message}`,
            };
          }

        } else if (provider === 'cli') {
          // CLI models — check if binary exists
          const router = getProviderRouter();
          const cliProvider = router.getCLIProvider();
          const tools = await cliProvider.getAvailableTools();
          const tool = tools.find(t =>
            t.modelPatterns.some(p => modelId === p || modelId.startsWith(p + '/'))
          );
          if (!tool) {
            return { success: false, error: `No CLI tool found for model "${modelId}"` };
          }
          if (!tool.available) {
            return { success: false, error: `CLI tool "${tool.name}" is not installed on this system` };
          }
          return { success: true, message: `${tool.name} binary detected and available` };

        } else {
          // Direct providers (openai, anthropic, gemini, deepseek, voyage)
          // Try the direct provider first; fall back to LiteLLM proxy
          const router = getProviderRouter();
          const directProvider = router.getAllProviders().find(p => p.name === provider);

          if (directProvider) {
            // Check if the provider has an API key configured
            const health = await directProvider.checkHealth();
            if (!health.healthy && health.error?.toLowerCase().includes('not configured')) {
              return { success: false, error: `${provider} API key is not configured. Add it on the Secrets page.` };
            }

            try {
              const result = await directProvider.complete({
                model: modelId,
                messages: [{ role: 'user', content: 'Say ok', timestamp: new Date() }],
                maxTokens: 5,
                temperature: 0,
              });
              const reply = result.content || '';
              return { success: true, message: `Model responded: "${reply.slice(0, 100)}"` };
            } catch (directErr) {
              return { success: false, error: `Direct ${provider} test failed: ${(directErr as Error).message}` };
            }
          }

          // Fallback: LiteLLM proxy
          const config = getConfig();
          const litellmBase = config.litellm.proxyUrl || 'http://localhost:4000';
          const litellmKey = config.litellm.apiKey || process.env.LITELLM_MASTER_KEY;
          if (!litellmKey) {
            return { success: false, error: `No direct provider or LiteLLM proxy configured for "${provider}"` };
          }
          try {
            const testRes = await fetch(`${litellmBase}/v1/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${litellmKey}`,
              },
              body: JSON.stringify({
                model: modelId,
                messages: [{ role: 'user', content: 'Say ok' }],
                max_tokens: 5,
              }),
            });

            if (!testRes.ok) {
              const errData = await testRes.json().catch(() => ({}));
              const errMsg = errData?.error?.message || `LiteLLM returned ${testRes.status}`;
              // Fail loud: a 401 here almost always means the proxy enforces a
              // master key but Octipus has none (litellm.apiKey / LITELLM_MASTER_KEY).
              // Surface it in the log, not just the HTTP response, so it's debuggable.
              coreLogger.error(
                {
                  status: testRes.status,
                  litellmBase,
                  modelId,
                  provider,
                  hasKey: !!litellmKey,
                  keySource: config.litellm.apiKey ? 'config' : process.env.LITELLM_MASTER_KEY ? 'env' : 'none',
                  errData,
                },
                'LiteLLM model test rejected',
              );
              return { success: false, error: errMsg };
            }

            const testData = await testRes.json();
            const reply = testData.choices?.[0]?.message?.content || '';
            return { success: true, message: `Model responded via LiteLLM: "${reply.slice(0, 100)}"` };
          } catch (fetchErr) {
            coreLogger.error(
              { err: fetchErr, litellmBase, modelId, provider },
              'Cannot reach LiteLLM proxy',
            );
            return { success: false, error: `Cannot reach LiteLLM proxy at ${litellmBase}` };
          }
        }
      } catch (err) {
        coreLogger.error({ err, provider: body.provider, modelId: body.modelId }, 'Model test failed');
        return { success: false, error: (err as Error).message };
      }
    },
    {
      body: t.Object({
        provider: t.String(),
        modelId: t.String(),
        endpoint: t.Optional(t.String()),
        apiKeyRef: t.Optional(t.String()),
        metadata: t.Optional(t.Any()),
      }),
      detail: { tags: ['models'] },
    }
  )

  // Register a new model (admin only)
  .post(
    '/',
    async ({ user, body }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      // Validate OpenRouter model IDs must contain a slash (provider/model format)
      if (body.provider === 'openrouter' && !body.modelId.includes('/')) {
        return {
          error: `OpenRouter models require "provider/model" format (e.g., "minimax/minimax-01"), got "${body.modelId}"`,
        };
      }

      const registry = getModelRegistry();

      // Check for duplicate name before inserting
      const existing = await registry.getModel(body.name);
      if (existing) {
        return { error: `A model with name "${body.name}" already exists` };
      }

      try {
        const model = await registry.registerModel(body as NewModelConfigEntry);
        return model;
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('unique') || msg.includes('duplicate')) {
          return { error: `A model with name "${body.name}" already exists` };
        }
        return { error: `Failed to register model: ${msg}` };
      }
    },
    {
      body: t.Object({
        name: t.String(),
        provider: t.String(),
        modelId: t.String(),
        endpoint: t.Optional(t.String()),
        apiKeyRef: t.Optional(t.String()),
        maxTokens: t.Optional(t.Number()),
        contextWindow: t.Optional(t.Number()),
        supportsVision: t.Optional(t.Boolean()),
        supportsTools: t.Optional(t.Boolean()),
        supportsStreaming: t.Optional(t.Boolean()),
        topics: t.Optional(t.Array(t.String())),
        priority: t.Optional(t.Number()),
        costPerInputToken: t.Optional(t.Number()),
        costPerOutputToken: t.Optional(t.Number()),
        metadata: t.Optional(t.Any()),
      }),
      detail: { tags: ['models'] },
    }
  )

  // Update model (admin only)
  .patch(
    '/:name',
    async ({ user, params, body, set }) => {
      if (!user?.isAdmin) {
        set.status = 403;
        return { error: 'Admin access required' };
      }

      // Strip capability flags from user updates — supportsTools, supportsVision,
      // and supportsStreaming are derived from the provider capabilities system
      // (see src/models/capabilities.ts) and must not be overridden by user input.
      // This ensures capability presets remain the single source of truth.
      const { supportsTools: _t, supportsVision: _v, supportsStreaming: _s, ...safeUpdate } = body as any;

      try {
        const registry = getModelRegistry();
        const model = await registry.updateModel(params.name, safeUpdate as Partial<NewModelConfigEntry>);

        if (!model) {
          set.status = 404;
          return { error: 'Model not found' };
        }

        return {
          ...model,
          capabilities: getCapabilitiesForModel(model),
        };
      } catch (err) {
        // Without this catch, any DB-side failure (constraint, type mismatch,
        // unknown column from a stale schema) bubbled up to Elysia's default
        // handler as an opaque 500 with no error body. Logging + surfacing
        // the message lets the UI show the user what actually broke.
        coreLogger.error({ err, model: params.name, update: safeUpdate }, 'updateModel failed');
        set.status = 400;
        return { error: 'Failed to update model', details: (err as Error).message };
      }
    },
    {
      params: t.Object({
        name: t.String(),
      }),
      body: t.Object({
        endpoint: t.Optional(t.String()),
        apiKeyRef: t.Optional(t.String()),
        maxTokens: t.Optional(t.Number()),
        contextWindow: t.Optional(t.Number()),
        topics: t.Optional(t.Array(t.String())),
        isEnabled: t.Optional(t.Boolean()),
        priority: t.Optional(t.Number()),
        // supportsTools, supportsVision, supportsStreaming are intentionally
        // excluded — capabilities are preset per provider and not user-editable.
        costPerInputToken: t.Optional(t.Number()),
        costPerOutputToken: t.Optional(t.Number()),
        metadata: t.Optional(t.Any()),
      }),
      detail: { tags: ['models'] },
    }
  )

  // Delete model (admin only)
  .delete(
    '/:name',
    async ({ user, params }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      const registry = getModelRegistry();
      const deleted = await registry.deleteModel(params.name);

      return { deleted };
    },
    {
      params: t.Object({
        name: t.String(),
      }),
      detail: { tags: ['models'] },
    }
  )

  // Set default model (admin only)
  .post(
    '/:name/default',
    async ({ user, params }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      const registry = getModelRegistry();
      const success = await registry.setDefaultModel(params.name);

      return { success };
    },
    {
      params: t.Object({
        name: t.String(),
      }),
      detail: { tags: ['models'] },
    }
  )

  // Get model health
  .get(
    '/health',
    async ({ user }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const healthChecker = getHealthChecker();
      const health = await healthChecker.getSystemHealth();

      return health;
    },
    { detail: { tags: ['models'] } }
  )

  // Get CLI tools availability and quota
  .get(
    '/cli/status',
    async ({ user }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const router = getProviderRouter();
      const cliProvider = router.getCLIProvider();
      const quotaTracker = getQuotaTracker();

      const [tools, quotas] = await Promise.all([
        cliProvider.getAvailableTools(),
        quotaTracker.getAllStatuses(),
      ]);

      return {
        tools: tools.map(tool => {
          const quota = quotas.find(q => q.provider === tool.name.toLowerCase().replace(/\s+/g, '-'));
          return {
            ...tool,
            quota: quota || null,
          };
        }),
      };
    },
    { detail: { tags: ['models'] } }
  )

  // Get quota status for CLI providers
  .get(
    '/cli/quota',
    async ({ user }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const quotaTracker = getQuotaTracker();
      const statuses = await quotaTracker.getAllStatuses();

      return { quotas: statuses };
    },
    { detail: { tags: ['models'] } }
  )

  // Get quota usage history for a CLI provider
  .get(
    '/cli/quota/:provider/history',
    async ({ user, params, query }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const quotaTracker = getQuotaTracker();
      const days = query.days ? parseInt(query.days, 10) : 7;
      const history = await quotaTracker.getUsageHistory(params.provider, days);

      return { provider: params.provider, history };
    },
    {
      params: t.Object({
        provider: t.String(),
      }),
      query: t.Object({
        days: t.Optional(t.String()),
      }),
      detail: { tags: ['models'] },
    }
  )

  // Clear quota exhaustion (admin only)
  .post(
    '/cli/quota/:provider/clear',
    async ({ user, params }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      const quotaTracker = getQuotaTracker();
      await quotaTracker.clearExhaustion(params.provider);

      return { success: true };
    },
    {
      params: t.Object({
        provider: t.String(),
      }),
      detail: { tags: ['models'] },
    }
  )

  // List available Ollama models
  .get(
    '/providers/ollama/models',
    async ({ user }) => {
      if (!user) return { error: 'Not authenticated' };
      const config = getConfig();
      const ollamaUrl = config.ollama?.url;
      if (!ollamaUrl) return { error: 'Ollama URL not configured' };
      try {
        const res = await fetch(`${ollamaUrl}/api/tags`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return { error: `Ollama unreachable (${res.status})` };
        const data = await res.json();
        return {
          models: (data.models || []).map((m: any) => ({
            name: m.name,
            size: m.size,
            modifiedAt: m.modified_at,
          })),
        };
      } catch (err) {
        return { error: `Cannot reach Ollama: ${(err as Error).message}` };
      }
    },
    { detail: { tags: ['models'] } }
  )

  // hwfit: recommend local models for the detected hardware (read-only).
  // Scans the host, fetches live registry sizes, and scores the curated catalog.
  .post(
    '/recommend',
    async ({ user, set }) => {
      // Admin-gated: the scan reveals the SERVER's hardware (GPU/VRAM/RAM), not
      // the caller's — not for arbitrary tenants to enumerate.
      if (!user?.isAdmin) {
        set.status = 403;
        return { error: 'Admin access required' };
      }
      const { probeHardware } = await import('@/setup/probes');
      const { resolveSizes, scoreCatalog } = await import('@/capabilities/hwfit');
      const { describeModeForParams } = await import('@/core/orchestrator/mode-selector');
      const hardware = await probeHardware();
      const sized = await resolveSizes();
      const scored = scoreCatalog(hardware, sized);

      // Annotate each model with the orchestrator mode it would imply as the
      // default, so the UI can tell the user what the model means for how
      // Octipus runs (router/lite/full). Thresholds come from config.
      //
      // Only annotate models that could actually BE the orchestrator default —
      // i.e. text-generation models. Embedding and vision/OCR models can never
      // be the orchestrator, so a "router/lite/full" label on them is
      // meaningless and was the source of the inconsistent UI text.
      const orch = getConfig().orchestrator;
      const thresholds = {
        routerSmallModelMaxParams: orch.routerSmallModelMaxParams,
        liteModelMaxParams: orch.liteModelMaxParams,
      };
      const ORCHESTRATOR_CAPABLE_TOPICS = new Set(['chat', 'general', 'coding', 'research']);
      for (const s of scored) {
        if (!s.entry.topics.some((t) => ORCHESTRATOR_CAPABLE_TOPICS.has(t))) continue;
        const { mode, note } = describeModeForParams(s.entry.params, thresholds);
        s.orchestratorMode = mode;
        s.orchestratorModeNote = note;
      }
      return { hardware, scored };
    },
    { detail: { tags: ['models'] } }
  )

  // hwfit: pull a recommended model into Ollama, register it, and bind topics.
  // Admin-gated; only catalog ids may be pulled (no arbitrary model strings).
  .post(
    '/install',
    async ({ user, body, set }) => {
      if (!user?.isAdmin) {
        set.status = 403;
        return { error: 'Admin access required' };
      }
      const { getCatalogEntry } = await import('@/capabilities/hwfit');
      const { startInstall } = await import('@/capabilities/hwfit/install');
      const { OllamaProvider } = await import('@/models/providers/ollama-provider');

      const entry = getCatalogEntry(body.id);
      if (!entry) {
        set.status = 400;
        return { error: `Unknown catalog model "${body.id}"` };
      }

      const registry = getModelRegistry();
      if (await registry.getModel(entry.id)) {
        set.status = 409;
        return { error: `Model "${entry.id}" is already registered` };
      }

      const provider = getProviderRouter().getProviderByName('ollama');
      if (!(provider instanceof OllamaProvider)) {
        set.status = 500;
        return { error: 'Ollama provider unavailable' };
      }

      // Bind only to topics the model actually serves; default to all of them.
      const requested = body.bindTopics ?? [];
      const bindTopics = (requested.length ? entry.topics.filter((t) => requested.includes(t)) : entry.topics);
      if (bindTopics.length === 0) {
        set.status = 400;
        return { error: `None of the requested topics are served by "${entry.id}"` };
      }

      const job = startInstall(entry, bindTopics, user.id, {
        pull: (id, onProgress) => provider.pull(id, onProgress),
        register: async (e) => {
          await registry.registerModel(e);
        },
        isFirstModel: async () => (await registry.getDefaultModel()) === null,
      });
      return { jobId: job.id, status: job.status, bindTopics };
    },
    {
      body: t.Object({
        id: t.String(),
        bindTopics: t.Optional(t.Array(t.String())),
      }),
      detail: { tags: ['models'] },
    }
  )

  // hwfit: poll the progress of an install job started by POST /install.
  .get(
    '/install/:jobId',
    async ({ user, params, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const { getInstallJob } = await import('@/capabilities/hwfit/install');
      const job = getInstallJob(params.jobId);
      // Scope to the owner (or an admin) — cross-tenant ids look like "not found".
      if (!job || (job.ownerId !== user.id && !user.isAdmin)) {
        set.status = 404;
        return { error: 'Install job not found' };
      }
      return job;
    },
    {
      params: t.Object({ jobId: t.String() }),
      detail: { tags: ['models'] },
    }
  )

  // List available DeepSeek models — live-fetched from the DeepSeek API
  // and merged with the static catalog so we keep price / context metadata
  // for known IDs while surfacing any new ones the account has access to.
  .get(
    '/providers/deepseek/models',
    async ({ user }) => {
      if (!user) return { error: 'Not authenticated' };

      const router = getProviderRouter();
      const provider = router.getAllProviders().find(p => p.name === 'deepseek') as
        | DeepSeekProvider
        | undefined;
      if (!provider) return { error: 'DeepSeek provider not registered' };

      let liveIds: string[] = [];
      let liveError: string | undefined;
      try {
        liveIds = await provider.listModels();
      } catch (err) {
        liveError = (err as Error).message;
      }

      const { inferTier } = await import('@/models/providers/discovery/curation');
      const models = liveIds.map(id => ({
        id,
        label: id,
        tier: inferTier(id),
        live: true,
      }));
      return { models, live: liveIds.length > 0, error: liveError };
    },
    { detail: { tags: ['models'] } }
  )

  // List available LiteLLM models with provider info
  .get(
    '/providers/litellm/models',
    async ({ user }) => {
      if (!user) return { error: 'Not authenticated' };
      const config = getConfig();
      const litellmBase = config.litellm.proxyUrl || 'http://localhost:4000';
      const litellmKey = config.litellm.apiKey || process.env.LITELLM_MASTER_KEY || '';
      const headers: Record<string, string> = {};
      if (litellmKey) headers['Authorization'] = `Bearer ${litellmKey}`;

      try {
        // Use /model/info for richer data (includes litellm_params.model with provider prefix)
        const res = await fetch(`${litellmBase}/model/info`, {
          headers,
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          coreLogger.error(
            {
              status: res.status,
              litellmBase,
              hasKey: !!litellmKey,
              keySource: config.litellm.apiKey ? 'config' : process.env.LITELLM_MASTER_KEY ? 'env' : 'none',
            },
            'LiteLLM model list rejected',
          );
          return { error: `LiteLLM unreachable (${res.status})` };
        }
        const data = await res.json();

        const models = (data.data || []).map((m: any) => {
          const litellmModel: string = m.litellm_params?.model || '';
          const provider = litellmModel.includes('/') ? litellmModel.split('/')[0] : 'unknown';
          return {
            id: m.model_name,
            provider,
            litellmModel,
          };
        });

        return { models };
      } catch (err) {
        coreLogger.error({ err, litellmBase }, 'Cannot reach LiteLLM for model list');
        return { error: `Cannot reach LiteLLM: ${(err as Error).message}` };
      }
    },
    { detail: { tags: ['models'] } }
  )

  // Search OpenRouter models (live API) — must be before :provider wildcard routes
  .get(
    '/providers/openrouter/search',
    async ({ user, query }) => {
      if (!user) return { error: 'Not authenticated' };

      const q = (query.q || '').trim().toLowerCase();
      const limit = Math.min(Math.max(parseInt(query.limit || '20', 10) || 20, 1), 50);

      // Get OpenRouter API key
      let apiKey = process.env.OPENROUTER_API_KEY || '';
      if (!apiKey) {
        try {
          const { getVault } = await import('@/security/vault');
          const vault = getVault();
          apiKey = (await vault.getByName('system', 'openrouter_api_key')) || '';
        } catch (err) { coreLogger.error({ err }, 'silent failure in models'); }
      }

      if (!apiKey) {
        return {
          configured: false,
          error: 'OpenRouter API key not configured. Add it on the Secrets page or set OPENROUTER_API_KEY.',
          models: [],
        };
      }

      try {
        const allModels = await fetchOpenRouterModels(apiKey);

        let filtered: OpenRouterApiModel[];
        if (q) {
          filtered = allModels.filter(m =>
            m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
          );
        } else {
          // No query — return the first N models (OpenRouter returns them by popularity)
          filtered = allModels;
        }

        const results = filtered.slice(0, limit).map(mapOpenRouterModel);

        return {
          configured: true,
          models: results,
          total: filtered.length,
          cached: openRouterModelCache ? Date.now() - openRouterModelCache.fetchedAt < 1000 ? false : true : false,
        };
      } catch (err) {
        return {
          configured: true,
          error: `Failed to fetch OpenRouter models: ${(err as Error).message}`,
          models: [],
        };
      }
    },
    {
      query: t.Object({
        q: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
      detail: { tags: ['models'] },
    }
  )

  // Discover models from a custom endpoint (custom-openai / custom-anthropic /
  // custom-gemini). The user supplies the endpoint + auth in the add-model form;
  // we hit the gateway's list-models route so they don't have to type model ids
  // by hand. OpenAI-standard `/v1/models` returns { data: [{ id, owned_by }] };
  // native Gemini `/v1beta/models` returns { models: [{ name }] }. We accept
  // either shape (the default path is chosen by flavor, overridable).
  .post(
    '/custom/discover-models',
    async ({ user, body }) => {
      // Model management is admin-only: this triggers an authenticated outbound
      // fetch to a user-supplied URL, so it must not be reachable by non-admins.
      if (!user?.isAdmin) return { configured: false, error: 'Admin access required', models: [] };

      const endpoint = body.endpoint?.replace(/\/+$/, '');
      if (!endpoint) return { configured: false, error: 'Endpoint URL is required', models: [] };

      const path = body.path || (body.provider === 'custom-gemini' ? '/v1beta/models' : '/v1/models');

      // Build auth — bearer (default), custom header, or query param. The key is
      // optional: some gateways (e.g. TPG) leave the list-models route open.
      const headers: Record<string, string> = { Accept: 'application/json' };
      const queryParams: Record<string, string> = {};
      const apiKey = await resolveCustomApiKey(body.apiKeyRef, user.id);
      if (apiKey) {
        const authType = body.authType || 'bearer';
        if (authType === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
        else if (authType === 'header' && body.headerName) headers[body.headerName] = apiKey;
        else if (authType === 'query' && body.paramName) queryParams[body.paramName] = apiKey;
      }
      const qs = Object.keys(queryParams).length
        ? (path.includes('?') ? '&' : '?') + new URLSearchParams(queryParams).toString()
        : '';

      try {
        // fetchGuarded validates the scheme + resolves/pins the host through the
        // SSRF guard (rejects private IPs, file://, cloud-metadata, etc.) so an
        // admin-supplied endpoint can't be used to reach internal services.
        const res = await fetchGuarded(`${endpoint}${path}${qs}`, {
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          return {
            configured: true,
            error: `Endpoint returned ${res.status}${txt ? `: ${txt.slice(0, 200)}` : ''}`,
            models: [],
          };
        }
        const json = await res.json() as {
          data?: Array<{ id: string; owned_by?: string; displayName?: string }>;
          models?: Array<{ name?: string; displayName?: string }>;
        };

        let models: Array<{ id: string; label: string; ownedBy?: string }> = [];
        if (Array.isArray(json.data)) {
          models = json.data.map((m) => ({ id: m.id, label: m.displayName || m.id, ownedBy: m.owned_by }));
        } else if (Array.isArray(json.models)) {
          // Native Gemini: name is "models/{id}" → strip the "models/" prefix.
          models = json.models
            .filter((m) => m.name)
            .map((m) => {
              const id = m.name!.replace(/^models\//, '');
              return { id, label: m.displayName || id };
            });
        } else {
          return { configured: true, error: 'Unrecognized model-list response shape', models: [] };
        }

        return { configured: true, models, total: models.length };
      } catch (err) {
        const e = err as Error;
        const msg = e.name === 'TimeoutError' || e.name === 'AbortError'
          ? 'Timed out reaching endpoint (10s)'
          : `Failed to reach endpoint: ${e.message}`;
        return { configured: true, error: msg, models: [] };
      }
    },
    {
      body: t.Object({
        provider: t.Optional(t.String()),
        endpoint: t.Optional(t.String()),
        apiKeyRef: t.Optional(t.String()),
        authType: t.Optional(t.Union([t.Literal('bearer'), t.Literal('header'), t.Literal('query')])),
        headerName: t.Optional(t.String()),
        paramName: t.Optional(t.String()),
        path: t.Optional(t.String()),
      }),
      detail: { tags: ['models'] },
    }
  )

  // Known models for a provider — now derived from live discovery cache.
  // Returns shortlist ids only, for legacy callers that just want a string[].
  .get(
    '/providers/:provider/known',
    async ({ user, params }) => {
      if (!user) return { error: 'Not authenticated' };
      const { discover, getDiscoverableProviders } = await import(
        '@/models/providers/discovery'
      );
      if (!getDiscoverableProviders().includes(params.provider)) {
        return { models: [] };
      }
      const result = await discover(params.provider, { userId: user?.id });
      return { models: result.shortlist.map(m => m.id) };
    },
    {
      params: t.Object({ provider: t.String() }),
      detail: { tags: ['models'] },
    }
  )

  // List available models for a direct provider — live discovery + curation.
  // No hardcoded id arrays: every result comes from the vendor's list endpoint
  // (with Redis cache + stale-while-revalidate). See ./discovery/.
  .get(
    '/providers/:provider/available',
    async ({ user, params, query }) => {
      if (!user) return { error: 'Not authenticated' };

      const { discover, getDiscoverableProviders } = await import(
        '@/models/providers/discovery'
      );
      const provider = params.provider;

      if (!getDiscoverableProviders().includes(provider)) {
        return { configured: false, error: `Discovery not supported for provider: ${provider}` };
      }

      const credsOverride = provider === 'ollama' && query.endpoint
        ? { endpoint: query.endpoint }
        : undefined;

      const result = await discover(
        provider,
        {
          includePreview: query.preview === 'true',
          includeNonChat: query.embeddings === 'true',
          bypassCache: query.refresh === 'true',
          userId: user?.id,
        },
        credsOverride,
      );

      if (result.source === 'unconfigured') {
        return { configured: false, error: result.error };
      }

      return {
        configured: true,
        models: result.shortlist,
        hiddenCount: result.hiddenCount,
        lastFetched: result.lastFetched,
        source: result.source,
        error: result.error,
      };
    },
    {
      params: t.Object({ provider: t.String() }),
      query: t.Object({
        endpoint: t.Optional(t.String()),
        preview: t.Optional(t.String()),
        embeddings: t.Optional(t.String()),
        refresh: t.Optional(t.String()),
      }),
      detail: { tags: ['models'] },
    }
  )

  // Update custom model catalog for a provider
  .put(
    '/providers/:provider/catalog',
    async ({ user, params, body }) => {
      if (!user?.isAdmin) return { error: 'Admin access required' };

      const { getSettingsService } = await import('@/config/settings-service');
      const svc = getSettingsService();
      await svc.set('models.catalog.' + params.provider, body.models, user.id);

      return { success: true };
    },
    {
      params: t.Object({ provider: t.String() }),
      body: t.Object({ models: t.Array(t.Any()) }),
      detail: { tags: ['models'] },
    }
  )

  // Get usage stats
  .get(
    '/usage',
    async ({ user, query }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const costTracker = getCostTracker();

      let since: Date | undefined;
      if (query.since) {
        since = new Date(query.since);
      }

      const stats = await costTracker.getUserStats(user.id, since);
      const byModel = await costTracker.getUserStatsByModel(user.id, since);

      return { stats, byModel };
    },
    {
      query: t.Object({
        since: t.Optional(t.String()),
      }),
      detail: { tags: ['models'] },
    }
  )

  // Get daily usage
  .get(
    '/usage/daily',
    async ({ user, query }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const costTracker = getCostTracker();
      const days = query.days ? parseInt(query.days, 10) : 30;

      const daily = await costTracker.getDailyUsage(user.id, days);

      return { daily };
    },
    {
      query: t.Object({
        days: t.Optional(t.String()),
      }),
      detail: { tags: ['models'] },
    }
  )

  // Get global usage (admin only)
  .get(
    '/usage/global',
    async ({ user, query }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      const costTracker = getCostTracker();

      let since: Date | undefined;
      if (query.since) {
        since = new Date(query.since);
      }

      const stats = await costTracker.getGlobalStats(since);

      return stats;
    },
    {
      query: t.Object({
        since: t.Optional(t.String()),
      }),
      detail: { tags: ['models'] },
    }
  );
