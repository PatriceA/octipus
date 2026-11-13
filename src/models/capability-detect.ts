/**
 * What a chat model can take as input: images, audio, tool calls.
 *
 * The native multimodal path (docs/MEDIA.md) depends on `supports_vision` and
 * `supports_audio_input` being right, so they are detected rather than left at
 * their `false` default:
 *
 *   - Ollama reports it per model: `POST /api/show` → `capabilities`
 *     (`completion`, `tools`, `vision`, `audio`, `embedding`, `thinking`, …).
 *   - Other providers: their model lists where the API says it (OpenRouter's
 *     `input_modalities`), else a curated per-family table below. The table is
 *     metadata about model FAMILIES, never a model choice: nothing here picks
 *     a model, it only says what a model the operator chose can read.
 *
 * Detection only ever turns a flag ON. A flag the operator turns off in the
 * model editor after detection stays off (the row is marked
 * `metadata.capabilitiesDetectedAt` and not detected again).
 */
import { modelLogger } from '@/utils/logger';

export interface DetectedInputs {
  image?: boolean;
  audio?: boolean;
  tools?: boolean;
}

/** Ollama's own answer for one installed model. Throws when Ollama cannot be asked. */
export async function detectOllamaInputs(endpoint: string, modelId: string, timeoutMs = 5_000): Promise<DetectedInputs> {
  const base = endpoint.replace(/\/+$/, '').replace(/\/v1$/, '');
  const res = await fetch(`${base}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelId }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Ollama /api/show answered ${res.status} for ${modelId}`);
  const body = await res.json() as { capabilities?: unknown };
  const caps = Array.isArray(body.capabilities) ? body.capabilities.filter((c): c is string => typeof c === 'string') : [];
  return {
    image: caps.includes('vision'),
    audio: caps.includes('audio'),
    ...(caps.length > 0 ? { tools: caps.includes('tools') } : {}),
  };
}

/**
 * Model families whose input modalities are documented by their vendor.
 * Matched against the model id without its provider prefix (`openai/`,
 * `google/`), case-insensitively. First match wins.
 */
const FAMILY_INPUTS: ReadonlyArray<{ pattern: RegExp; inputs: DetectedInputs }> = [
  // Audio-in chat models first: their ids also match the broader families.
  { pattern: /gpt-4o(-mini)?-audio|gpt-audio|gpt-realtime/, inputs: { audio: true } },
  { pattern: /voxtral(?!.*tts)/, inputs: { audio: true } },
  { pattern: /qwen[\d.]*-?omni/, inputs: { image: true, audio: true } },
  { pattern: /gemma-?3n/, inputs: { image: true, audio: true } },
  { pattern: /^gemini-(1\.5|2|3)/, inputs: { image: true, audio: true } },
  // Image-in families.
  { pattern: /^(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o1(?!-mini)|o3|o4-mini|chatgpt-4o)/, inputs: { image: true } },
  { pattern: /^claude-(3|sonnet-4|opus-4|haiku-4|sonnet-5|opus-5|haiku-5|fable)/, inputs: { image: true } },
  { pattern: /pixtral|mistral-(medium|small)-(3|2025|2026|latest)|magistral-(medium|small)-1\.2/, inputs: { image: true } },
  { pattern: /-vl\b|-vl-|vl:|qwen[\d.]*vl|qwen3\.[5-9]|qwen3-vl/, inputs: { image: true } },
  { pattern: /^gemma-?[34]|gemma[34]:/, inputs: { image: true } },
  { pattern: /llava|bakllava|minicpm-v|moondream|llama3\.2-vision|llama-?4|granite3\.2-vision|granite-vision/, inputs: { image: true } },
  { pattern: /glm-4(\.\d+)?v|glm-5(\.\d+)?v|kimi-vl|kimi-k2\.5/, inputs: { image: true } },
  { pattern: /^grok-(2-vision|4|5)/, inputs: { image: true } },
  { pattern: /deepseek-ocr|glm-ocr|olmocr|nanonets-ocr|dots\.ocr|mistral-ocr/, inputs: { image: true } },
];

/** What the vendor documents for this model's family, or undefined when unknown. */
export function inferInputsFromFamily(modelId: string): DetectedInputs | undefined {
  const id = modelId.toLowerCase().replace(/^[a-z0-9-]+\//, '');
  return FAMILY_INPUTS.find(({ pattern }) => pattern.test(id))?.inputs;
}

/**
 * Detect what `row` can take as input. Ollama is asked; everything else is
 * looked up by family. Returns undefined when nothing is known — the row's
 * flags are then left as they are.
 */
export async function detectInputs(row: { provider: string; modelId: string; endpoint?: string | null }, ollamaUrl?: string): Promise<DetectedInputs | undefined> {
  if (row.provider === 'ollama') {
    const endpoint = row.endpoint || ollamaUrl;
    if (!endpoint) return inferInputsFromFamily(row.modelId);
    try {
      return await detectOllamaInputs(endpoint, row.modelId);
    } catch (err) {
      // Ollama down or the model not pulled yet: the family table is the next best answer.
      modelLogger.debug({ err, model: row.modelId }, 'Ollama capability probe failed; using the family table');
      return inferInputsFromFamily(row.modelId);
    }
  }
  // A CLI agent reads files itself; its row flags are not about our message format.
  if (row.provider === 'cli') return undefined;
  return inferInputsFromFamily(row.modelId);
}

/** The flag changes detection would make: only ever turning a flag on. */
export function upgradeFlags(
  current: { supportsVision: boolean; supportsAudioInput: boolean },
  detected: DetectedInputs | undefined,
): { supportsVision?: true; supportsAudioInput?: true } {
  if (!detected) return {};
  return {
    ...(detected.image && !current.supportsVision ? { supportsVision: true as const } : {}),
    ...(detected.audio && !current.supportsAudioInput ? { supportsAudioInput: true as const } : {}),
  };
}

/**
 * Boot: detect once for every row not detected before (installs from before
 * detection — an Ollama qwen3.x row that reads images but says it does not).
 * In the background, never blocking boot; each row is marked so a later
 * correction in the model editor is not overwritten.
 */
export async function detectCapabilitiesForUndetectedRows(): Promise<number> {
  const { getModelRegistry } = await import('./model-registry');
  const { getConfig } = await import('@/config');
  const registry = getModelRegistry();
  const rows = await registry.getAllModels();
  let changed = 0;
  for (const row of rows) {
    if (row.metadata?.capabilitiesDetectedAt) continue;
    const detected = await detectInputs(row, getConfig().ollama?.url);
    const flags = upgradeFlags({ supportsVision: row.supportsVision, supportsAudioInput: row.supportsAudioInput ?? false }, detected);
    await registry.updateModel(row.name, {
      ...flags,
      metadata: { ...(row.metadata ?? {}), capabilitiesDetectedAt: new Date().toISOString() },
    });
    if (Object.keys(flags).length > 0) {
      changed++;
      modelLogger.info({ model: row.name, ...flags }, 'Detected model input capabilities');
    }
  }
  return changed;
}
