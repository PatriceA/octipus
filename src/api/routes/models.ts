import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getModelRegistry } from '@/models/model-registry';
import { getCostTracker } from '@/models/cost-tracker';
import { getHealthChecker } from '@/models/health-checker';
import { getProviderRouter } from '@/models/providers';
import { getQuotaTracker } from '@/models/quota-tracker';
import { getConfig } from '@/config';
import type { NewModelConfigEntry } from '@/db/schema/models';
import { getCapabilitiesForModel } from '@/models/capabilities';

// ── Known model catalog with specs & pricing ────────────────────────
// Prices are per 1M tokens. Context/max output in tokens.
interface KnownModel {
  id: string;
  label: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  costPerInputToken?: number;   // $ per 1M input tokens
  costPerOutputToken?: number;  // $ per 1M output tokens
  supportsVision?: boolean;
  supportsTools?: boolean;
}

const KNOWN_PROVIDER_MODELS: Record<string, KnownModel[]> = {
  openai: [
    // GPT-5.4 frontier family
    { id: 'gpt-5.4', label: 'GPT-5.4', contextWindow: 1000000, maxOutputTokens: 128000, costPerInputToken: 2.50, costPerOutputToken: 15.00, supportsVision: true, supportsTools: true },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', contextWindow: 400000, maxOutputTokens: 128000, costPerInputToken: 0.75, costPerOutputToken: 4.50, supportsVision: true, supportsTools: true },
    { id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano', contextWindow: 400000, maxOutputTokens: 128000, costPerInputToken: 0.20, costPerOutputToken: 1.25, supportsVision: true, supportsTools: true },
    // GPT-4o family
    { id: 'gpt-4o', label: 'GPT-4o', contextWindow: 128000, maxOutputTokens: 16384, costPerInputToken: 2.50, costPerOutputToken: 10.00, supportsVision: true, supportsTools: true },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini', contextWindow: 128000, maxOutputTokens: 16384, costPerInputToken: 0.15, costPerOutputToken: 0.60, supportsVision: true, supportsTools: true },
    // Reasoning
    { id: 'o3', label: 'o3', contextWindow: 200000, maxOutputTokens: 100000, costPerInputToken: 2.00, costPerOutputToken: 8.00, supportsVision: true, supportsTools: true },
    { id: 'o4-mini', label: 'o4 Mini', contextWindow: 200000, maxOutputTokens: 100000, costPerInputToken: 1.10, costPerOutputToken: 4.40, supportsVision: true, supportsTools: true },
    // Embeddings
    { id: 'text-embedding-3-large', label: 'Embedding 3 Large', contextWindow: 8191, costPerInputToken: 0.13 },
    { id: 'text-embedding-3-small', label: 'Embedding 3 Small', contextWindow: 8191, costPerInputToken: 0.02 },
    // Transcription / TTS
    { id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe (STT)', contextWindow: 128000 },
    { id: 'gpt-4o-mini-tts', label: 'GPT-4o Mini TTS', contextWindow: 128000 },
  ],
  anthropic: [
    // Claude 4.6 (latest)
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', contextWindow: 1000000, maxOutputTokens: 128000, costPerInputToken: 5.00, costPerOutputToken: 25.00, supportsVision: true, supportsTools: true },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindow: 1000000, maxOutputTokens: 64000, costPerInputToken: 3.00, costPerOutputToken: 15.00, supportsVision: true, supportsTools: true },
    // Claude 4.5
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', contextWindow: 200000, maxOutputTokens: 64000, costPerInputToken: 1.00, costPerOutputToken: 5.00, supportsVision: true, supportsTools: true },
    { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', contextWindow: 1000000, maxOutputTokens: 64000, costPerInputToken: 3.00, costPerOutputToken: 15.00, supportsVision: true, supportsTools: true },
    { id: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5', contextWindow: 200000, maxOutputTokens: 64000, costPerInputToken: 5.00, costPerOutputToken: 25.00, supportsVision: true, supportsTools: true },
    // Claude 4
    { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', contextWindow: 200000, maxOutputTokens: 64000, costPerInputToken: 3.00, costPerOutputToken: 15.00, supportsVision: true, supportsTools: true },
    { id: 'claude-opus-4-20250514', label: 'Claude Opus 4', contextWindow: 200000, maxOutputTokens: 32000, costPerInputToken: 15.00, costPerOutputToken: 75.00, supportsVision: true, supportsTools: true },
  ],
  gemini: [
    // Gemini 3 (preview)
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Preview)', contextWindow: 1048576, maxOutputTokens: 65536, costPerInputToken: 2.00, costPerOutputToken: 12.00, supportsVision: true, supportsTools: true },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (Preview)', contextWindow: 1048576, maxOutputTokens: 65536, costPerInputToken: 0.50, costPerOutputToken: 3.00, supportsVision: true, supportsTools: true },
    { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite (Preview)', contextWindow: 1048576, maxOutputTokens: 65536, costPerInputToken: 0.25, costPerOutputToken: 1.50, supportsVision: true, supportsTools: true },
    // Gemini 2.5 (stable)
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextWindow: 1048576, maxOutputTokens: 65536, costPerInputToken: 1.25, costPerOutputToken: 10.00, supportsVision: true, supportsTools: true },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextWindow: 1048576, maxOutputTokens: 65536, costPerInputToken: 0.30, costPerOutputToken: 2.50, supportsVision: true, supportsTools: true },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', contextWindow: 1048576, maxOutputTokens: 65536, costPerInputToken: 0.10, costPerOutputToken: 0.40, supportsVision: true, supportsTools: true },
    // Embeddings
    { id: 'gemini-embedding-2-preview', label: 'Gemini Embedding 2 (Preview)', contextWindow: 8192, costPerInputToken: 0.20 },
  ],
  deepseek: [
    // DeepSeek V3.2
    { id: 'deepseek-chat', label: 'DeepSeek V3.2 (Chat)', contextWindow: 128000, maxOutputTokens: 8192, costPerInputToken: 0.28, costPerOutputToken: 0.42, supportsTools: true },
    { id: 'deepseek-reasoner', label: 'DeepSeek V3.2 (Reasoner)', contextWindow: 128000, maxOutputTokens: 64000, costPerInputToken: 0.28, costPerOutputToken: 0.42 },
  ],
  openrouter: [
    // Popular models via OpenRouter (prices are OpenRouter's, may differ from direct)
    { id: 'openai/gpt-4o', label: 'GPT-4o (via OpenRouter)', contextWindow: 128000, maxOutputTokens: 16384, costPerInputToken: 2.50, costPerOutputToken: 10.00, supportsVision: true, supportsTools: true },
    { id: 'openai/gpt-4o-mini', label: 'GPT-4o Mini (via OpenRouter)', contextWindow: 128000, maxOutputTokens: 16384, costPerInputToken: 0.15, costPerOutputToken: 0.60, supportsVision: true, supportsTools: true },
    { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (via OpenRouter)', contextWindow: 200000, maxOutputTokens: 64000, costPerInputToken: 3.00, costPerOutputToken: 15.00, supportsVision: true, supportsTools: true },
    { id: 'anthropic/claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (via OpenRouter)', contextWindow: 200000, maxOutputTokens: 64000, costPerInputToken: 1.00, costPerOutputToken: 5.00, supportsVision: true, supportsTools: true },
    { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash (via OpenRouter)', contextWindow: 1048576, maxOutputTokens: 65536, costPerInputToken: 0.15, costPerOutputToken: 0.60, supportsVision: true, supportsTools: true },
    { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro (via OpenRouter)', contextWindow: 1048576, maxOutputTokens: 65536, costPerInputToken: 1.25, costPerOutputToken: 10.00, supportsVision: true, supportsTools: true },
    { id: 'deepseek/deepseek-chat-v3-0324', label: 'DeepSeek V3 (via OpenRouter)', contextWindow: 128000, maxOutputTokens: 8192, costPerInputToken: 0.28, costPerOutputToken: 0.42, supportsTools: true },
    { id: 'meta-llama/llama-4-scout', label: 'Llama 4 Scout (via OpenRouter)', contextWindow: 512000, maxOutputTokens: 32768, costPerInputToken: 0.15, costPerOutputToken: 0.40, supportsVision: true, supportsTools: true },
    { id: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick (via OpenRouter)', contextWindow: 1048576, maxOutputTokens: 65536, costPerInputToken: 0.25, costPerOutputToken: 0.75, supportsVision: true, supportsTools: true },
    { id: 'qwen/qwen-3-235b-a22b', label: 'Qwen 3 235B (via OpenRouter)', contextWindow: 131072, maxOutputTokens: 32768, costPerInputToken: 0.30, costPerOutputToken: 1.20, supportsTools: true },
  ],
  voyage: [
    // Primary models
    { id: 'voyage-4-large', label: 'Voyage 4 Large', contextWindow: 32000, costPerInputToken: 0.12 },
    { id: 'voyage-4', label: 'Voyage 4', contextWindow: 32000, costPerInputToken: 0.06 },
    { id: 'voyage-4-lite', label: 'Voyage 4 Lite', contextWindow: 32000, costPerInputToken: 0.02 },
    { id: 'voyage-context-3', label: 'Voyage Context 3', contextWindow: 32000, costPerInputToken: 0.18 },
    { id: 'voyage-code-3', label: 'Voyage Code 3', contextWindow: 32000, costPerInputToken: 0.18 },
    // Specialized
    { id: 'voyage-finance-2', label: 'Voyage Finance 2', contextWindow: 32000, costPerInputToken: 0.12 },
    { id: 'voyage-law-2', label: 'Voyage Law 2', contextWindow: 16000, costPerInputToken: 0.12 },
    { id: 'voyage-multilingual-2', label: 'Voyage Multilingual 2', contextWindow: 32000, costPerInputToken: 0.12 },
    { id: 'voyage-code-2', label: 'Voyage Code 2', contextWindow: 16000, costPerInputToken: 0.12 },
  ],
};

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
          } catch (fetchErr) {
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

      const registry = getModelRegistry();
      const model = await registry.registerModel(body as NewModelConfigEntry);

      return model;
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

  // Known models for a provider (static list — kept for backwards compat)
  .get(
    '/providers/:provider/known',
    async ({ user, params }) => {
      if (!user) return { error: 'Not authenticated' };

      const catalog = KNOWN_PROVIDER_MODELS[params.provider];
      return { models: catalog ? catalog.map(m => m.id) : [] };
    },
    {
      params: t.Object({ provider: t.String() }),
      detail: { tags: ['models'] },
    }
  )

  // List available models for a direct provider (checks configuration first)
  .get(
    '/providers/:provider/available',
    async ({ user, params, query }) => {
      if (!user) return { error: 'Not authenticated' };

      const provider = params.provider;

      // Ollama: live model list (supports custom endpoint via ?endpoint=)
      if (provider === 'ollama') {
        const config = getConfig();
        const url = query.endpoint || config.ollama?.url;
        if (!url) return { configured: false, error: 'Ollama URL not configured' };
        try {
          const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
          if (!res.ok) return { configured: false, error: `Ollama unreachable at ${url} (${res.status})` };
          const data = await res.json();
          const models = (data.models || []).map((m: { name: string; details?: { parameter_size?: string; family?: string } }) => ({
            id: m.name,
            label: m.name,
            parameterSize: m.details?.parameter_size,
          }));
          return { configured: true, models };
        } catch (err) {
          return { configured: false, error: `Cannot reach Ollama at ${url}: ${(err as Error).message}` };
        }
      }

      // Cloud providers: check API key
      const router = getProviderRouter();
      const directProvider = router.getAllProviders().find(p => p.name === provider);
      if (!directProvider) {
        return { configured: false, error: `Unknown provider: ${provider}` };
      }

      const health = await directProvider.checkHealth();
      if (!health.healthy && health.error?.toLowerCase().includes('not configured')) {
        return { configured: false, error: `${provider} API key not configured. Add it on the Secrets page.` };
      }

      // Merge built-in catalog with user-customized entries from settings
      const builtIn = KNOWN_PROVIDER_MODELS[provider] || [];
      let custom: KnownModel[] = [];
      try {
        const { getSettingsService } = await import('@/config/settings-service');
        const svc = getSettingsService();
        const raw = svc.getSync('models.catalog.' + provider) as KnownModel[] | undefined;
        if (Array.isArray(raw)) custom = raw;
      } catch {}

      // Custom entries override built-in by id, then append new ones
      const builtInIds = new Set(builtIn.map(m => m.id));
      const merged = [
        ...builtIn.map(m => {
          const override = custom.find(c => c.id === m.id);
          return override ? { ...m, ...override } : m;
        }),
        ...custom.filter(c => !builtInIds.has(c.id)),
      ];

      return { configured: true, models: merged, source: 'known' };
    },
    {
      params: t.Object({ provider: t.String() }),
      query: t.Object({ endpoint: t.Optional(t.String()) }),
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
