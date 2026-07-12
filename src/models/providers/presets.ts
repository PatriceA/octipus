/**
 * Local-runtime presets (WS8 item 1) — one-click setup for self-hosted
 * OpenAI-compatible model servers (llama.cpp, LM Studio, vLLM, SGLang, …).
 *
 * The transport already exists: `CustomOpenAICompatProvider` speaks the OpenAI
 * `/v1/chat/completions` wire format against any endpoint. The only gap was UX —
 * a user had to hand-craft a `model_config` row. This registry supplies the
 * boilerplate (default endpoint, path, auth, health probe) per runtime, plus
 * model autodiscovery via the endpoint's `/v1/models`, so `octi setup` and the
 * models UI can offer "LM Studio → http://localhost:1234/v1" one-click.
 *
 * No new provider classes, no new dependencies.
 */

/** How a preset maps onto a `custom-openai` model_config. */
export interface LocalRuntimePreset {
  /** Stable id (used in setup/UI). */
  id: string;
  /** Human label. */
  label: string;
  /** Default base URL (host + `/v1`) most installs use out of the box. */
  defaultEndpoint: string;
  /**
   * Auth default. Local runtimes are usually unauthenticated; a placeholder
   * bearer token is still sent (some servers require a non-empty key).
   */
  auth: 'none' | 'bearer';
  /** Optional request-path override (defaults to `/chat/completions` under the base URL). */
  pathOverride?: string;
  /** One-line note shown in setup/UI. */
  notes?: string;
}

/**
 * The base URL of these presets already includes `/v1`, so model discovery hits
 * `<endpoint>/models` and chat hits `<endpoint>/chat/completions` — matching the
 * OpenAI path layout every one of these runtimes implements.
 */
export const LOCAL_RUNTIME_PRESETS: readonly LocalRuntimePreset[] = [
  {
    id: 'lmstudio',
    label: 'LM Studio',
    defaultEndpoint: 'http://localhost:1234/v1',
    auth: 'none',
    notes: 'Start the local server from LM Studio → Developer → Start Server.',
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp (llama-server)',
    defaultEndpoint: 'http://localhost:8080/v1',
    auth: 'none',
    notes: 'Run `llama-server -m model.gguf --host 0.0.0.0 --port 8080`.',
  },
  {
    id: 'vllm',
    label: 'vLLM',
    defaultEndpoint: 'http://localhost:8000/v1',
    auth: 'none',
    notes: 'Run `vllm serve <model>` (OpenAI-compatible server on :8000).',
  },
  {
    id: 'sglang',
    label: 'SGLang',
    defaultEndpoint: 'http://localhost:30000/v1',
    auth: 'none',
    notes: 'Run `python -m sglang.launch_server --model-path <model> --port 30000`.',
  },
  {
    id: 'tgi',
    label: 'Text Generation Inference (TGI)',
    defaultEndpoint: 'http://localhost:8080/v1',
    auth: 'none',
    notes: 'HF TGI exposes an OpenAI-compatible `/v1` route.',
  },
  {
    id: 'ollama-openai',
    label: 'Ollama (OpenAI-compatible endpoint)',
    defaultEndpoint: 'http://localhost:11434/v1',
    auth: 'none',
    notes: 'Ollama serves an OpenAI-compatible API at /v1. (Native Ollama provider is usually preferable.)',
  },
] as const;

export function listPresets(): readonly LocalRuntimePreset[] {
  return LOCAL_RUNTIME_PRESETS;
}

export function getPreset(id: string): LocalRuntimePreset | undefined {
  return LOCAL_RUNTIME_PRESETS.find((p) => p.id === id);
}

/** Trim a trailing slash so `${endpoint}/models` never doubles up. */
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '');
}

/** Injectable fetch — the real global by default, a fake in tests. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Autodiscover model ids from an OpenAI-compatible `<endpoint>/models` listing.
 * Returns `[]` on any failure (endpoint down, non-JSON, unexpected shape) so the
 * caller can degrade to manual model entry. `timeoutMs` bounds a wedged server.
 */
export async function discoverModels(
  endpoint: string,
  opts: { fetch?: FetchLike; timeoutMs?: number; apiKey?: string } = {},
): Promise<string[]> {
  const doFetch = opts.fetch ?? (globalThis.fetch as FetchLike);
  const url = `${normalizeEndpoint(endpoint)}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  try {
    const headers: Record<string, string> = {};
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    const res = await doFetch(url, { headers, signal: controller.signal });
    if (!res.ok) return [];
    const body = (await res.json()) as unknown;
    return parseModelList(body);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Extract model ids from an OpenAI `/models` response (`{ data: [{ id }] }`), tolerant of shape. */
export function parseModelList(body: unknown): string[] {
  const data = (body as { data?: unknown })?.data;
  const rows = Array.isArray(data) ? data : Array.isArray(body) ? (body as unknown[]) : [];
  const ids: string[] = [];
  for (const row of rows) {
    const id = (row as { id?: unknown })?.id;
    if (typeof id === 'string' && id.length > 0) ids.push(id);
  }
  return ids;
}

/** Health probe: `<endpoint>/models` returns 2xx. Cheap, no model load. */
export async function probeHealth(
  endpoint: string,
  opts: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<boolean> {
  const doFetch = opts.fetch ?? (globalThis.fetch as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 3000);
  try {
    const res = await doFetch(`${normalizeEndpoint(endpoint)}/models`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The `model_config` fields a preset produces for a chosen endpoint + model. */
export interface PresetModelConfig {
  provider: 'custom-openai';
  modelId: string;
  endpoint: string;
  customProvider: {
    auth: { type: 'bearer' };
    pathOverride?: string;
  };
}

/**
 * Build the `model_config` fields for `modelId` served by `preset` at `endpoint`
 * (defaults to the preset's endpoint). The result feeds the existing
 * `CustomOpenAICompatProvider` path — no new provider class.
 */
export function buildModelConfigFromPreset(
  preset: LocalRuntimePreset,
  modelId: string,
  endpoint?: string,
): PresetModelConfig {
  const cfg: PresetModelConfig = {
    provider: 'custom-openai',
    modelId,
    endpoint: normalizeEndpoint(endpoint ?? preset.defaultEndpoint),
    customProvider: { auth: { type: 'bearer' } },
  };
  if (preset.pathOverride) cfg.customProvider.pathOverride = preset.pathOverride;
  return cfg;
}
