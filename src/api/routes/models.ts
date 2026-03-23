import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getModelRegistry } from '@/models/model-registry';
import { getCostTracker } from '@/models/cost-tracker';
import { getHealthChecker } from '@/models/health-checker';
import { getProviderRouter } from '@/models/providers';
import { getQuotaTracker } from '@/models/quota-tracker';
import { getConfig } from '@/config';
import type { NewModelConfigEntry } from '@/db/schema/models';

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

      return model;
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
          // For LiteLLM-proxied models (openai, anthropic, deepseek, etc.)
          // Test via LiteLLM proxy
          const config = getConfig();
          const litellmBase = config.litellm.proxyUrl || 'http://localhost:4000';
          const litellmKey = config.litellm.apiKey || process.env.LITELLM_MASTER_KEY;
          if (!litellmKey) {
            return { success: false, error: 'LITELLM_API_KEY is not configured' };
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
            return { success: true, message: `Model responded: "${reply.slice(0, 100)}"` };
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

      const registry = getModelRegistry();
      const model = await registry.updateModel(params.name, body as Partial<NewModelConfigEntry>);

      if (!model) {
        return { error: 'Model not found' };
      }

      return model;
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
        supportsVision: t.Optional(t.Boolean()),
        supportsTools: t.Optional(t.Boolean()),
        supportsStreaming: t.Optional(t.Boolean()),
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
      try {
        const res = await fetch(`${config.ollama.url}/api/tags`, {
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

  // Known models for a provider (static list)
  .get(
    '/providers/:provider/known',
    async ({ user, params }) => {
      if (!user) return { error: 'Not authenticated' };

      const known: Record<string, string[]> = {
        openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3-mini'],
        anthropic: ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001', 'claude-3-5-sonnet-20241022'],
        gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
        deepseek: ['deepseek-chat', 'deepseek-reasoner'],
      };

      return { models: known[params.provider] || [] };
    },
    {
      params: t.Object({ provider: t.String() }),
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
