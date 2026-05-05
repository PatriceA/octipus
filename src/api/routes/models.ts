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
      const models = await registry.getAllModelsIncludeDisabled();

      return {
        models: models.map((m) => ({
          id: m.id,
          name: m.name,
          provider: m.provider,
          modelId: m.modelId,
          endpoint: m.endpoint,
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

          // Test Ollama directly — check if model exists
          const ollamaBase = endpoint || 'http://localhost:11434';
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
              return { success: false, error: errMsg };
            }

            const testData = await testRes.json();
            const reply = testData.choices?.[0]?.message?.content || '';
            return { success: true, message: `Model responded via LiteLLM: "${reply.slice(0, 100)}"` };
          } catch (_fetchErr) {
            return { success: false, error: `Cannot reach LiteLLM proxy at ${litellmBase}` };
          }
        }
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
    {
      body: t.Object({
        provider: t.String(),
        modelId: t.String(),
        endpoint: t.Optional(t.String()),
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
      }),
      detail: { tags: ['models'] },
    }
  )

  // Update model (admin only)
  .patch(
    '/:name',
    async ({ user, params, body }) => {
      if (!user?.isAdmin) {
        return { error: 'Admin access required' };
      }

      // Strip capability flags from user updates — supportsTools, supportsVision,
      // and supportsStreaming are derived from the provider capabilities system
      // (see src/models/capabilities.ts) and must not be overridden by user input.
      // This ensures capability presets remain the single source of truth.
      const { supportsTools: _t, supportsVision: _v, supportsStreaming: _s, ...safeUpdate } = body as any;

      const registry = getModelRegistry();
      const model = await registry.updateModel(params.name, safeUpdate as Partial<NewModelConfigEntry>);

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
        if (!res.ok) return { error: `LiteLLM unreachable (${res.status})` };
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
      const result = await discover(params.provider);
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
