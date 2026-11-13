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
export async function detectOllamaInputs(endpoint: string, modelId: string, timeoutMs = 5_000): Promise<DetectedInputs | undefined> {
  const base = endpoint.replace(/\/+$/, '').replace(/\/v1$/, '');
  const res = await fetch(`${base}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelId }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Ollama /api/show answered ${res.status} for ${modelId}`);
  const body = await res.json() as { capabilities?: unknown };
  // An Ollama too old to report capabilities has not answered; the caller decides.
  if (!Array.isArray(body.capabilities)) return undefined;
  const caps = body.capabilities.filter((c): c is string => typeof c === 'string');
  return {
    image: caps.includes('vision'),
    audio: caps.includes('audio'),
    ...(caps.length > 0 ? { tools: caps.includes('tools') } : {}),
  };
}

/**
 * Model ids that are not chat models at all (speech, transcription, search,
 * embeddings, image generation, moderation): never given image or audio
 * input, whatever family they share a prefix with.
 */
const NOT_CHAT = /(transcribe|-tts\b|tts-|realtime|-search|embed|whisper|moderation|dall-e|gpt-image|imagen|-image-preview|-image-generation)/;

/**
 * Model families whose input modalities are documented by their vendor, with
 * the text-only members of those families excluded explicitly (an image sent
 * to a model that cannot read it is a 400, so a false "yes" breaks chat; a
 * false "no" only means an image is described instead of seen). Matched
 * against the id without its provider prefix, case-insensitively. First match wins.
 */
const FAMILY_INPUTS: ReadonlyArray<{ pattern: RegExp; inputs: DetectedInputs }> = [
  // Audio-in chat models first: their ids also match the broader families.
  { pattern: /^gpt-4o(-mini)?-audio|^gpt-audio/, inputs: { audio: true } },
  { pattern: /^voxtral-(mini|small)(-\d|-latest|$)/, inputs: { audio: true } },
  { pattern: /^qwen[\d.]*-?omni/, inputs: { image: true, audio: true } },
  { pattern: /^gemma-?3n/, inputs: { image: true, audio: true } },
  { pattern: /^gemini-(1\.5|2\.0|2\.5|3)(\.\d)?-(pro|flash)(?!-lite-preview-tts)/, inputs: { image: true, audio: true } },
  // Image-in families. OpenAI: the o-series minis and previews are text-only.
  { pattern: /^(chatgpt-4o|gpt-4o(-mini)?(-\d|$|-latest)|gpt-4\.1|gpt-4-turbo(-\d|$)|gpt-5(\.\d)?(-mini|-nano)?(-\d|$|-chat|-latest)|o1(-\d|$)|o3(-\d|$|-pro)|o4-mini(-\d|$))/, inputs: { image: true } },
  { pattern: /^claude-(3-|3\.5-|3\.7-|sonnet-4|opus-4|haiku-4|sonnet-5|opus-5|haiku-5|fable)/, inputs: { image: true } },
  { pattern: /^(pixtral|mistral-medium-(3|2[5-9]|latest)|mistral-small-(3\.[12]|2[5-9]|latest)|magistral-(medium|small)-1\.2)/, inputs: { image: true } },
  { pattern: /(^|[-:])vl([-:.]|$)|qwen[\d.]*-?vl|^qwen3\.[5-9]/, inputs: { image: true } },
  // Gemma 3 reads images from 4b up; 1b and 270m are text-only. Gemma 4: all sizes.
  { pattern: /^gemma-?3[:-]?(4b|12b|27b)|^gemma-?4/, inputs: { image: true } },
  { pattern: /^(llava|bakllava|minicpm-v|moondream|llama3\.2-vision|llama-?4|granite3\.2-vision|granite-vision)/, inputs: { image: true } },
  { pattern: /^(glm-4(\.\d+)?v|glm-5(\.\d+)?v|kimi-vl)/, inputs: { image: true } },
  { pattern: /^grok-(2-vision|4|5)/, inputs: { image: true } },
  { pattern: /^(deepseek-ocr|glm-ocr|olmocr|nanonets-ocr|dots\.ocr|mistral-ocr)/, inputs: { image: true } },
];

/** What the vendor documents for this model's family, or undefined when unknown. */
export function inferInputsFromFamily(modelId: string): DetectedInputs | undefined {
  const id = modelId.toLowerCase().replace(/^[a-z0-9-]+\//, '');
  if (NOT_CHAT.test(id)) return undefined;
  return FAMILY_INPUTS.find(({ pattern }) => pattern.test(id))?.inputs;
}

/** An answer from the provider itself (authoritative) or from the family table (a best guess). */
export interface Detection {
  inputs: DetectedInputs;
  authoritative: boolean;
}

/** Providers whose own answer comes from elsewhere (OpenRouter's model list); the table never second-guesses them. */
const PROVIDER_ANSWERS_ITSELF = new Set(['openrouter', 'litellm', 'cli']);

/**
 * Detect what `row` can take as input. Ollama is asked (authoritative); a
 * cloud provider's models are looked up by family (a documented answer).
 * Undefined when nothing is known — the row's flags are then left alone, and
 * an Ollama that could not be asked is asked again next time.
 */
export async function detectInputs(row: { provider: string; modelId: string; endpoint?: string | null }, ollamaUrl?: string): Promise<Detection | undefined> {
  if (PROVIDER_ANSWERS_ITSELF.has(row.provider)) return undefined;
  if (row.provider === 'ollama') {
    const endpoint = row.endpoint || ollamaUrl;
    if (!endpoint) return undefined;
    try {
      const inputs = await detectOllamaInputs(endpoint, row.modelId);
      return inputs ? { inputs, authoritative: true } : undefined;
    } catch (err) {
      // Ollama down, or the model not pulled yet: not an answer. Asked again on a later boot.
      modelLogger.debug({ err, model: row.modelId }, 'Ollama capability probe failed; flags left as they are');
      return undefined;
    }
  }
  const inputs = inferInputsFromFamily(row.modelId);
  return inputs ? { inputs, authoritative: true } : undefined;
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
 * In the background, never blocking boot.
 *
 *   - Only an authoritative answer stamps the row (`capabilitiesDetectedAt`);
 *     an Ollama that is still starting is asked again next boot.
 *   - The row is re-read right before the write and its metadata merged, so
 *     an edit made while Ollama was being asked is kept.
 *   - Nothing is written when nothing changes and the row is already stamped.
 */
export async function detectCapabilitiesForUndetectedRows(): Promise<number> {
  const { getModelRegistry } = await import('./model-registry');
  const { getConfig } = await import('@/config');
  const registry = getModelRegistry();
  const rows = await registry.getAllModelsIncludeDisabled();
  let changed = 0;
  for (const listed of rows) {
    if (listed.metadata?.capabilitiesDetectedAt) continue;
    const detection = await detectInputs(listed, getConfig().ollama?.url);
    if (!detection) continue;
    const row = await registry.getModel(listed.name);
    if (!row || row.metadata?.capabilitiesDetectedAt) continue;
    const flags = upgradeFlags({ supportsVision: row.supportsVision, supportsAudioInput: row.supportsAudioInput ?? false }, detection.inputs);
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
