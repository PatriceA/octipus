import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { discoverModels, listPresets, probeHealth } from '@/models/providers/presets';
import type { CustomProviderConfig } from '@/db/schema/models';
import {
  checkCapabilities,
  clearCliQuota,
  deleteModel,
  getAvailableProviderModels,
  getCliQuotaHistory,
  getCliQuotas,
  getCliStatus,
  getDailyUsage,
  getGlobalUsage,
  getInstallJobScoped,
  getKnownProviderModels,
  getModelByName,
  getSystemHealth,
  getUsage,
  installRecommendedModel,
  listModels,
  recommendModels,
  registerModel,
  setDefaultModel,
  updateModel,
  updateProviderCatalog,
} from '@/services/model-service';
import {
  discoverCustomModels,
  listDeepSeekModels,
  listLiteLLMModels,
  listOllamaModels,
  searchOpenRouterModels,
  testModelConnection,
} from '@/services/provider-service';

export const modelRoutes = new Elysia({ prefix: '/models' })
  .use(apiContext)
  // List all models
  .get(
    '/',
    async ({ user }) => {
      if (!user) return { error: 'Not authenticated' };
      return listModels(user.id, user.isAdmin);
    },
    { detail: { tags: ['models'] } }
  )

  // WS8 — local-runtime presets (llama.cpp / LM Studio / vLLM / SGLang …) for
  // one-click self-hosted model setup. Registered before /:name so the static
  // path wins.
  .get(
    '/presets',
    async ({ user }) => {
      if (!user) return { error: 'Not authenticated' };
      return { presets: listPresets() };
    },
    { detail: { tags: ['models'] } }
  )

  // Autodiscover models from a local OpenAI-compatible endpoint + health probe.
  .post(
    '/discover',
    async ({ user, body }) => {
      if (!user?.isAdmin) return { error: 'Admin access required' };
      const [models, healthy] = await Promise.all([
        discoverModels(body.endpoint, { apiKey: body.apiKey }),
        probeHealth(body.endpoint),
      ]);
      return { models, healthy };
    },
    {
      body: t.Object({ endpoint: t.String(), apiKey: t.Optional(t.String()) }),
      detail: { tags: ['models'] },
    }
  )

  // Get model by name
  .get(
    '/:name',
    async ({ user, params }) => {
      if (!user) return { error: 'Not authenticated' };
      return getModelByName(params.name);
    },
    {
      params: t.Object({ name: t.String() }),
      detail: { tags: ['models'] },
    }
  )

  // Test model connection before registering
  .post(
    '/test',
    async ({ user, body }) => {
      if (!user?.isAdmin) return { error: 'Admin access required' };
      return testModelConnection({
        provider: body.provider,
        modelId: body.modelId,
        endpoint: body.endpoint,
        apiKeyRef: (body as { apiKeyRef?: string }).apiKeyRef,
        metadata: (body as { metadata?: { customProvider?: CustomProviderConfig } }).metadata,
        userId: user.id,
      });
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
      if (!user?.isAdmin) return { error: 'Admin access required' };
      return registerModel(body as Record<string, unknown>);
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
        // topics/topicRoles intentionally omitted — binding is owned by the Topics page.
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
      const result = await updateModel(params.name, body as Record<string, unknown>);
      if ('ok' in result) return result.model;
      set.status = result.status;
      return result.details !== undefined
        ? { error: result.error, details: result.details }
        : { error: result.error };
    },
    {
      params: t.Object({ name: t.String() }),
      body: t.Object({
        endpoint: t.Optional(t.String()),
        apiKeyRef: t.Optional(t.String()),
        maxTokens: t.Optional(t.Number()),
        contextWindow: t.Optional(t.Number()),
        // topics/topicRoles are intentionally excluded — topic↔model binding is
        // owned by the Topics page (PUT /topics/:topic/binding), not the model
        // editor. Keeping a topic writer here would be a second source of truth.
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
      if (!user?.isAdmin) return { error: 'Admin access required' };
      return deleteModel(params.name);
    },
    {
      params: t.Object({ name: t.String() }),
      detail: { tags: ['models'] },
    }
  )

  // Set default model (admin only)
  .post(
    '/:name/default',
    async ({ user, params }) => {
      if (!user?.isAdmin) return { error: 'Admin access required' };
      return setDefaultModel(params.name);
    },
    {
      params: t.Object({ name: t.String() }),
      detail: { tags: ['models'] },
    }
  )

  // Capability gate: run the tool-calling + JSON conformance subset against one
  // model and return a verdict. Use before relying on a small/local model for
  // agent work. Live test — issues a couple of real completions to the model.
  .post(
    '/:name/check-capabilities',
    async ({ user, params, set }) => {
      if (!user?.isAdmin) {
        set.status = 403;
        return { error: 'Admin access required' };
      }
      const result = await checkCapabilities(params.name, user.id);
      if ('ok' in result) return result.verdict;
      set.status = result.status;
      return { error: result.error };
    },
    {
      params: t.Object({ name: t.String() }),
      detail: { tags: ['models'] },
    }
  )

  // Get model health
  .get(
    '/health',
    async ({ user }) => {
      if (!user) return { error: 'Not authenticated' };
      return getSystemHealth();
    },
    { detail: { tags: ['models'] } }
  )

  // Get CLI tools availability and quota
  .get(
    '/cli/status',
    async ({ user }) => {
      if (!user) return { error: 'Not authenticated' };
      return getCliStatus();
    },
    { detail: { tags: ['models'] } }
  )

  // Get quota status for CLI providers
  .get(
    '/cli/quota',
    async ({ user }) => {
      if (!user) return { error: 'Not authenticated' };
      return getCliQuotas();
    },
    { detail: { tags: ['models'] } }
  )

  // Get quota usage history for a CLI provider
  .get(
    '/cli/quota/:provider/history',
    async ({ user, params, query }) => {
      if (!user) return { error: 'Not authenticated' };
      const days = query.days ? parseInt(query.days, 10) : 7;
      return getCliQuotaHistory(params.provider, days);
    },
    {
      params: t.Object({ provider: t.String() }),
      query: t.Object({ days: t.Optional(t.String()) }),
      detail: { tags: ['models'] },
    }
  )

  // Clear quota exhaustion (admin only)
  .post(
    '/cli/quota/:provider/clear',
    async ({ user, params }) => {
      if (!user?.isAdmin) return { error: 'Admin access required' };
      return clearCliQuota(params.provider);
    },
    {
      params: t.Object({ provider: t.String() }),
      detail: { tags: ['models'] },
    }
  )

  // List available Ollama models
  .get(
    '/providers/ollama/models',
    async ({ user }) => {
      if (!user) return { error: 'Not authenticated' };
      return listOllamaModels();
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
      return recommendModels();
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
      const result = await installRecommendedModel(body.id, body.bindTopics, user.id);
      if ('ok' in result) return { jobId: result.jobId, status: result.status, bindTopics: result.bindTopics };
      set.status = result.status;
      return { error: result.error };
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
      const job = await getInstallJobScoped(params.jobId, user.id, user.isAdmin);
      if (!job) {
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
      return listDeepSeekModels();
    },
    { detail: { tags: ['models'] } }
  )

  // List available LiteLLM models with provider info
  .get(
    '/providers/litellm/models',
    async ({ user }) => {
      if (!user) return { error: 'Not authenticated' };
      return listLiteLLMModels();
    },
    { detail: { tags: ['models'] } }
  )

  // Search OpenRouter models (live API) — must be before :provider wildcard routes
  .get(
    '/providers/openrouter/search',
    async ({ user, query }) => {
      if (!user) return { error: 'Not authenticated' };
      const limit = Math.min(Math.max(parseInt(query.limit || '20', 10) || 20, 1), 50);
      return searchOpenRouterModels(query.q || '', limit);
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
      return discoverCustomModels({ ...body, userId: user.id });
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
      return getKnownProviderModels(params.provider, user.id);
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
      return getAvailableProviderModels(params.provider, query, user.id);
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
      return updateProviderCatalog(params.provider, body.models, user.id);
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
      if (!user) return { error: 'Not authenticated' };
      const since = query.since ? new Date(query.since) : undefined;
      return getUsage(user.id, since);
    },
    {
      query: t.Object({ since: t.Optional(t.String()) }),
      detail: { tags: ['models'] },
    }
  )

  // Get daily usage
  .get(
    '/usage/daily',
    async ({ user, query }) => {
      if (!user) return { error: 'Not authenticated' };
      const days = query.days ? parseInt(query.days, 10) : 30;
      return getDailyUsage(user.id, days);
    },
    {
      query: t.Object({ days: t.Optional(t.String()) }),
      detail: { tags: ['models'] },
    }
  )

  // Get global usage (admin only)
  .get(
    '/usage/global',
    async ({ user, query }) => {
      if (!user?.isAdmin) return { error: 'Admin access required' };
      const since = query.since ? new Date(query.since) : undefined;
      return getGlobalUsage(since);
    },
    {
      query: t.Object({ since: t.Optional(t.String()) }),
      detail: { tags: ['models'] },
    }
  );
