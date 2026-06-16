/**
 * Canonical provider registry — the single source of truth for which
 * LLM providers Octipus can be wired against during setup.
 *
 * Surfaces that need to know about providers (CLI wizard, web settings,
 * docker bootstrap, doctor, capability install hints) import from here.
 * No hardcoded provider lists anywhere else.
 *
 * Adding a provider:
 *   1. append to PROVIDERS below
 *   2. ensure the matching client exists in src/models/clients/
 *   3. add a vault key in `vaultKey` if it needs a secret
 *
 * Detection is optional — providers without `detect` show as manual-add.
 */

import { httpJson, probeLiteLLM, probeOllama, type ProbeResult } from './probes';

export type ProviderId =
  | 'ollama'
  | 'litellm'
  | 'openrouter'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'mistral'
  | 'cli';

export interface ProviderDef {
  /** Stable identifier used in env, vault, modelConfig.provider. */
  id: ProviderId;
  /** Human-facing label shown in setup wizard. */
  label: string;
  /** One-line explanation surfaced in the wizard. */
  description: string;
  /**
   * Sensible default model ID used when the provider lists no models or
   * the user accepts the default in non-interactive setup.
   */
  defaultModel: string;
  /**
   * `detected` providers run their `detect()` probe to pre-select.
   * `manual` providers always require explicit user choice (cloud APIs
   * with no zero-config endpoint to probe).
   */
  kind: 'detected' | 'manual';
  /** Does the provider need an API key written to the vault? */
  requiresApiKey: boolean;
  /** Vault key under which the API key is stored (when requiresApiKey). */
  vaultKey?: string;
  /** Detection probe — returns ok + optional detail (e.g. model count). */
  detect?: () => Promise<ProviderDetectResult>;
  /** Pull the live model list. Returns null if unavailable. */
  listModels?: (opts: { baseUrl?: string; apiKey?: string }) => Promise<string[] | null>;
}

export interface ProviderDetectResult extends ProbeResult {
  /** Number of models available locally, when applicable. */
  modelCount?: number;
}

// ── Provider list (order = setup-wizard display order) ────────────────

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    description: 'Local inference. Best for privacy / offline. Free.',
    defaultModel: 'llama3.2:3b',
    kind: 'detected',
    requiresApiKey: false,
    detect: async () => {
      const probe = await probeOllama();
      if (!probe.ok) return probe;
      const tags = await httpJson<{ models?: Array<{ name: string }> }>('http://localhost:11434/api/tags');
      const count = tags?.models?.length ?? 0;
      return { ...probe, modelCount: count };
    },
    listModels: async () => {
      const tags = await httpJson<{ models?: Array<{ name: string }> }>('http://localhost:11434/api/tags');
      return tags?.models?.map((m) => m.name) ?? null;
    },
  },
  {
    id: 'litellm',
    label: 'LiteLLM proxy',
    description: 'Existing LiteLLM proxy. We list its models.',
    defaultModel: 'openai/gpt-4o-mini',
    kind: 'detected',
    requiresApiKey: false, // Optional — proxy may be open
    vaultKey: 'litellm_api_key',
    detect: () => probeLiteLLM(),
    listModels: async ({ baseUrl, apiKey }) => {
      if (!baseUrl) return null;
      const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
      const data = await httpJson<{ data?: Array<{ id: string }> }>(
        `${baseUrl.replace(/\/$/, '')}/v1/models`,
        { headers },
      );
      return data?.data?.map((m) => m.id) ?? null;
    },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: '200+ models, single key. Pay-per-use.',
    defaultModel: 'openai/gpt-4o-mini',
    kind: 'manual',
    requiresApiKey: true,
    vaultKey: 'openrouter_api_key',
    listModels: async ({ apiKey }) => {
      if (!apiKey) return null;
      const data = await httpJson<{ data?: Array<{ id: string }> }>(
        'https://openrouter.ai/api/v1/models',
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      return data?.data?.map((m) => m.id) ?? null;
    },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT models. Requires API key.',
    defaultModel: 'gpt-4o-mini',
    kind: 'manual',
    requiresApiKey: true,
    vaultKey: 'openai_api_key',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude models. Requires API key.',
    defaultModel: 'claude-haiku-4-5-20251001',
    kind: 'manual',
    requiresApiKey: true,
    vaultKey: 'anthropic_api_key',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    description: 'Gemini models. Requires API key.',
    defaultModel: 'gemini-2.0-flash',
    kind: 'manual',
    requiresApiKey: true,
    vaultKey: 'gemini_api_key',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek models. Requires API key.',
    defaultModel: 'deepseek-chat',
    kind: 'manual',
    requiresApiKey: true,
    vaultKey: 'deepseek_api_key',
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    description: 'Mistral / Magistral / Codestral models. Requires API key.',
    defaultModel: 'mistral-large-latest',
    kind: 'manual',
    requiresApiKey: true,
    vaultKey: 'mistral_api_key',
    listModels: async ({ apiKey }) => {
      if (!apiKey) return null;
      const data = await httpJson<{ data?: Array<{ id: string }> }>(
        'https://api.mistral.ai/v1/models',
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      return data?.data?.map((m) => m.id) ?? null;
    },
  },
  {
    id: 'cli',
    label: 'Claude CLI (claude-code auth)',
    description: 'Uses your existing Claude Code auth. No key needed if signed in.',
    defaultModel: 'claude-sonnet-4-6',
    kind: 'manual',
    requiresApiKey: false,
  },
];

export function getProvider(id: ProviderId): ProviderDef {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

/**
 * Run detection across providers that opted in. Manual-only providers
 * are returned with `ok: false` so callers can render them consistently.
 */
export async function detectAllProviders(): Promise<Record<ProviderId, ProviderDetectResult>> {
  const entries = await Promise.all(
    PROVIDERS.map(async (p) => {
      if (!p.detect) {
        return [p.id, { ok: false, detail: 'manual' } as ProviderDetectResult] as const;
      }
      return [p.id, await p.detect()] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<ProviderId, ProviderDetectResult>;
}
