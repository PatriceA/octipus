/**
 * Provider service — provider connectivity + discovery logic.
 *
 * Extracted from `src/api/routes/models.ts` so the route handlers stay
 * thin (parse request → call function → return). These functions do the
 * outbound-fetch / provider-probing work: model connection tests, live
 * model listings (Ollama / DeepSeek / LiteLLM / OpenRouter), and custom
 * endpoint discovery. Return shapes are the exact objects the routes
 * previously returned inline — HTTP behaviour is unchanged.
 *
 * These paths hit no user-owned rows, so there's no scoped repo here;
 * user context flows in as a plain `userId` (for vault key lookups).
 */
import { getConfig } from '@/config';
import type { CustomProviderConfig } from '@/db/schema/models';
import { getProviderRouter } from '@/models/providers';
import type { DeepSeekProvider } from '@/models/providers/deepseek-provider';
import { coreLogger } from '@/utils/logger';
import { fetchGuarded } from '@/utils/sanitize';

/**
 * Resolve a custom-provider API key from an apiKeyRef.
 * Mirrors BaseCustomProvider.resolveApiKey but used at the API layer
 * for the test-model endpoint (where the provider hasn't been called yet).
 *
 * Lookup order: env: prefix → user's vault → system vault.
 */
export async function resolveCustomApiKey(
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

// ── Model connection test ────────────────────────────────────────────

export interface TestModelInput {
  provider: string;
  modelId: string;
  endpoint?: string;
  apiKeyRef?: string;
  metadata?: { customProvider?: CustomProviderConfig };
  userId?: string;
}

/**
 * Test a model connection before registering. Returns { success, message }
 * or { success: false, error }. Never throws — provider errors are mapped
 * into the result object (the route returns it verbatim).
 */
export async function testModelConnection(
  input: TestModelInput,
): Promise<{ success: boolean; message?: string; error?: string }> {
  const { provider, modelId, endpoint, apiKeyRef, metadata, userId } = input;
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

      const apiKey = await resolveCustomApiKey(apiKeyRef, userId);
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
    coreLogger.error({ err, provider, modelId }, 'Model test failed');
    return { success: false, error: (err as Error).message };
  }
}

// ── Live provider model listings ─────────────────────────────────────

/** List available Ollama models (live /api/tags). */
export async function listOllamaModels(): Promise<
  | { models: Array<{ name: string; size: unknown; modifiedAt: unknown }> }
  | { error: string }
> {
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
}

/** List DeepSeek models — live-fetched, merged with static tier inference. */
export async function listDeepSeekModels(): Promise<
  | { models: Array<{ id: string; label: string; tier: string; live: boolean }>; live: boolean; error?: string }
  | { error: string }
> {
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
}

/** List LiteLLM models with provider info (from /model/info). */
export async function listLiteLLMModels(): Promise<
  | { models: Array<{ id: string; provider: string; litellmModel: string }> }
  | { error: string }
> {
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
}

/** Search OpenRouter models (live API, cached). */
export async function searchOpenRouterModels(q: string, limit: number) {
  const query = q.trim().toLowerCase();

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
    if (query) {
      filtered = allModels.filter(m =>
        m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query)
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
}

// ── Custom endpoint discovery ────────────────────────────────────────

export interface DiscoverCustomInput {
  provider?: string;
  endpoint?: string;
  apiKeyRef?: string;
  authType?: 'bearer' | 'header' | 'query';
  headerName?: string;
  paramName?: string;
  path?: string;
  userId: string;
}

/**
 * Discover models from a custom endpoint (custom-openai / custom-anthropic /
 * custom-gemini). Accepts both OpenAI (`{data:[{id}]}`) and native Gemini
 * (`{models:[{name}]}`) list shapes. Uses fetchGuarded (SSRF guard).
 */
export async function discoverCustomModels(input: DiscoverCustomInput) {
  const endpoint = input.endpoint?.replace(/\/+$/, '');
  if (!endpoint) return { configured: false, error: 'Endpoint URL is required', models: [] };

  const path = input.path || (input.provider === 'custom-gemini' ? '/v1beta/models' : '/v1/models');

  // Build auth — bearer (default), custom header, or query param. The key is
  // optional: some gateways (e.g. TPG) leave the list-models route open.
  const headers: Record<string, string> = { Accept: 'application/json' };
  const queryParams: Record<string, string> = {};
  const apiKey = await resolveCustomApiKey(input.apiKeyRef, input.userId);
  if (apiKey) {
    const authType = input.authType || 'bearer';
    if (authType === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
    else if (authType === 'header' && input.headerName) headers[input.headerName] = apiKey;
    else if (authType === 'query' && input.paramName) queryParams[input.paramName] = apiKey;
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
}
