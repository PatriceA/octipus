import { classifyError } from '@/core/errors/classification';
import type { CustomProviderConfig, ModelConfigEntry, ModelMetadata } from '@/db/schema/models';
import type { CompletionOptions } from '../../litellm-client';
import { modelLogger } from '@/utils/logger';
import { fetchGuarded } from '@/utils/sanitize';

/**
 * The fetch a personal row's endpoint is reached with (coworking spec §8.4).
 * The endpoint is user-supplied, so every request re-resolves the host and
 * checks every address against private, loopback and link-local ranges, the
 * socket is pinned to the checked address (no second resolution to rebind),
 * and a redirect is returned, never followed — the provider then fails on the
 * 3xx like any other non-2xx answer.
 */
export const personalEndpointFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  return fetchGuarded(url, { ...init, redirect: 'manual' }, 0);
};

/**
 * Resolved per-call configuration for a custom-provider model row.
 * Returned by resolveModelConfig() and consumed by the concrete custom-provider
 * subclasses (OpenAI-compat, Gemini-compat).
 */
export interface ResolvedCustomConfig {
  baseUrl: string;
  apiKey: string;
  custom: CustomProviderConfig;
  model: ModelConfigEntry | null;
}

/**
 * Shared helpers for custom providers. Custom providers are stateless singletons:
 * each call resolves the upstream endpoint, API key, and envelope settings from
 * the model_config row at request time.
 */
export abstract class BaseCustomProvider {
  protected abstract readonly providerName: string;

  /**
   * Resolve the model row, endpoint, key, and custom-provider config.
   * Throws a classified AUTH_FAILED if the row is missing required fields.
   *
   * If options.customProviderOverride is set, returns that directly without
   * consulting the DB. Used by the test-model endpoint when the model hasn't
   * been persisted yet.
   */
  protected async resolveModelConfig(
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ResolvedCustomConfig> {
    if (options?.customProviderOverride) {
      const o = options.customProviderOverride;
      return {
        baseUrl: o.baseUrl.replace(/\/+$/, ''),
        apiKey: o.apiKey,
        custom: o.custom,
        model: null,
      };
    }

    const { getModelRegistry } = await import('@/models/model-registry');
    const registry = getModelRegistry();
    // The row the caller resolved (`modelConfigName`), else install rows by
    // modelId, then the requester's own personal rows — never another user's.
    const model = options?.modelConfigName
      ? await registry.getModel(options.modelConfigName)
      : await registry.getModelByModelId(modelId, { userId: options?.userId }) || await registry.getModel(modelId);

    if (!model) {
      throw classifyError(
        new Error(`Custom provider: no model row found for '${modelId}'`),
        this.providerName,
      );
    }

    if (!model.endpoint) {
      throw classifyError(
        new Error(`Custom provider: model '${modelId}' has no endpoint configured`),
        this.providerName,
      );
    }

    const metadata = (model.metadata || {}) as ModelMetadata;
    const custom = metadata.customProvider;
    if (!custom) {
      throw classifyError(
        new Error(`Custom provider: model '${modelId}' has no metadata.customProvider config`),
        this.providerName,
      );
    }

    // The caller's key wins (a key already resolved for this row); otherwise
    // the key resolves under the ROW's owner — the system vault for an install
    // row, the owner's vault for a personal one — never under the requester.
    const apiKey = options?.apiKey || (model.ownerUserId
      ? await this.resolvePersonalApiKey(model)
      : await this.resolveApiKey(model.apiKeyRef));

    return {
      baseUrl: model.endpoint.replace(/\/+$/, ''),
      apiKey,
      custom,
      model,
    };
  }

  /** A personal row's key: its owner's vault only — no `env:` reference, no env fallback. */
  private async resolvePersonalApiKey(model: ModelConfigEntry): Promise<string> {
    const { resolveModelKey } = await import('@/models/model-key');
    const key = await resolveModelKey(model);
    if (!key) throw classifyError(new Error(`Custom provider: personal model '${model.name}' has no API key`), this.providerName);
    return key;
  }

  /** The fetch for this row's endpoint: SSRF-guarded for a personal row, plain otherwise. */
  protected fetchFor(cfg: ResolvedCustomConfig): typeof fetch {
    return cfg.model?.ownerUserId ? personalEndpointFetch : fetch;
  }

  /**
   * Resolve an install row's API key from the system vault (by reference) or
   * fall back to env var. The apiKeyRef column is a vault entry name; if
   * absent, we try a conventional env var <PROVIDERNAME>_API_KEY.
   *
   * Lookup order: env: prefix → system-scoped vault → conventional env var
   * fallback. Never the requester's vault (coworking spec §8.3).
   */
  protected async resolveApiKey(apiKeyRef: string | null): Promise<string> {
    if (apiKeyRef) {
      // Env-var override: apiKeyRef = 'env:VAR_NAME' bypasses the vault entirely
      if (apiKeyRef.startsWith('env:')) {
        const envName = apiKeyRef.slice(4);
        const v = process.env[envName];
        if (v) return v;
        throw classifyError(
          new Error(`Custom provider: env var ${envName} not set (referenced by apiKeyRef)`),
          this.providerName,
        );
      }

      try {
        const { getVault } = await import('@/security/vault');
        const vault = getVault();
        const v = await vault.getByName('system', apiKeyRef);
        if (v) return v;
      } catch (err) {
        modelLogger.warn(
          { err: (err as Error).message, apiKeyRef, provider: this.providerName },
          'Custom provider: vault lookup failed, will fall back to env var',
        );
      }
    }

    const fallback = process.env[`${this.providerName.toUpperCase().replace(/-/g, '_')}_API_KEY`];
    if (fallback) return fallback;

    throw classifyError(
      new Error(`Custom provider: no API key resolved (apiKeyRef='${apiKeyRef ?? '<none>'}')`),
      this.providerName,
    );
  }

  /**
   * Build request headers based on the custom-provider auth config.
   * Adds Content-Type, the auth credential, and any extraHeaders.
   * Returns query-string params separately for type='query' auth.
   */
  protected buildHeaders(
    custom: CustomProviderConfig,
    apiKey: string,
  ): { headers: Record<string, string>; queryParams: Record<string, string> } {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(custom.extraHeaders || {}),
    };
    const queryParams: Record<string, string> = {};

    switch (custom.auth.type) {
      case 'bearer':
        headers['Authorization'] = `Bearer ${apiKey}`;
        break;
      case 'header':
        if (!custom.auth.headerName) {
          throw classifyError(
            new Error(`Custom provider: auth.type='header' requires auth.headerName`),
            this.providerName,
          );
        }
        headers[custom.auth.headerName] = apiKey;
        break;
      case 'query':
        if (!custom.auth.paramName) {
          throw classifyError(
            new Error(`Custom provider: auth.type='query' requires auth.paramName`),
            this.providerName,
          );
        }
        queryParams[custom.auth.paramName] = apiKey;
        break;
    }

    return { headers, queryParams };
  }

  /** Append query parameters to a URL */
  protected appendQuery(url: string, params: Record<string, string>): string {
    const keys = Object.keys(params);
    if (keys.length === 0) return url;
    const sep = url.includes('?') ? '&' : '?';
    return url + sep + keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  }
}
