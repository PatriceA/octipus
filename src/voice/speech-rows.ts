/**
 * Speech engines as model rows (docs/VOICE.md → Engines are models).
 *
 * Speech to text and text to speech run on the model bound to the
 * Transcription and Speech lanes, like every other kind of model work. The
 * engine adapters in `stt.ts` / `tts.ts` stay what they are — subprocess and
 * socket plumbing — but are only ever built from a row, here:
 *
 *   provider `local-audio`   whisper.cpp:<model> · faster-whisper:<size>   (Transcription)
 *                            kokoro:<voice> · piper:<voice>                (Speech)
 *   provider `mistral`       voxtral-* (both lanes)
 *   provider `openai`        gpt-4o-transcribe / whisper-1 · gpt-4o-mini-tts
 *
 * The model id, key (`apiKeyRef`) and streaming model come from the row, never
 * from a constant. `SPEECH_ENGINE_CATALOG` is the curated list of engines the
 * setup and the migration can create rows for — a list of what exists, not a
 * choice: nothing is used until it is bound to a lane.
 */
import type { ModelConfigEntry, NewModelConfigEntry } from '@/db/schema/models';
import type { STTEngine } from './stt';
import type { TTSEngine } from './tts';

export const LOCAL_AUDIO_PROVIDER = 'local-audio';

export type SpeechDirection = 'stt' | 'tts';
export type SpeechFormat = 'mp3' | 'wav' | 'opus' | 'ogg' | 'pcm' | 'flac';

/**
 * The file extension for an audio MIME type — the name a cloud API and
 * ffmpeg read the container from (`audio/x-m4a` → m4a, `audio/mpeg` → mp3).
 */
export function audioExtensionFor(mimeType: string | undefined, fallback = 'ogg'): string {
  const sub = (mimeType?.split('/')[1] || '').split(';')[0].trim().toLowerCase().replace(/^x-/, '');
  const known: Record<string, string> = {
    mpeg: 'mp3', mp3: 'mp3', mpga: 'mp3', mp4: 'm4a', m4a: 'm4a', aac: 'aac', wav: 'wav', wave: 'wav',
    ogg: 'ogg', opus: 'opus', webm: 'webm', flac: 'flac', amr: 'amr', '3gpp': '3gp',
  };
  if (sub.startsWith('vnd.wave')) return 'wav';
  return known[sub] ?? (/^[a-z0-9]{2,5}$/.test(sub) ? sub : fallback);
}

/** The engine families a row can be, and their old `voice.*Provider` names (kept as request aliases). */
export type SpeechEngineKind = 'whisper' | 'fasterwhisper' | 'kokoro' | 'piper' | 'mistral' | 'openai';

export interface SpeechEngineEntry {
  kind: SpeechEngineKind;
  direction: SpeechDirection;
  /** The row this engine is registered as. */
  row: Pick<NewModelConfigEntry, 'name' | 'provider' | 'modelId'> & { metadata?: NewModelConfigEntry['metadata'] };
}

/** Curated: the engines Octipus can drive. Model ids are the vendors' current ones. */
export const SPEECH_ENGINE_CATALOG: readonly SpeechEngineEntry[] = [
  { kind: 'whisper', direction: 'stt', row: { name: 'local whisper.cpp base', provider: LOCAL_AUDIO_PROVIDER, modelId: 'whisper.cpp:base' } },
  { kind: 'fasterwhisper', direction: 'stt', row: { name: 'local faster-whisper small', provider: LOCAL_AUDIO_PROVIDER, modelId: 'faster-whisper:small' } },
  { kind: 'mistral', direction: 'stt', row: { name: 'mistral voxtral transcribe', provider: 'mistral', modelId: 'voxtral-mini-latest', metadata: { speech: { streamingModel: 'voxtral-mini-transcribe-realtime-2602' } } } },
  { kind: 'openai', direction: 'stt', row: { name: 'openai gpt-4o-transcribe', provider: 'openai', modelId: 'gpt-4o-transcribe', metadata: { speech: { streamingModel: 'gpt-realtime-whisper' } } } },
  { kind: 'kokoro', direction: 'tts', row: { name: 'local kokoro', provider: LOCAL_AUDIO_PROVIDER, modelId: 'kokoro:af_sarah', metadata: { speech: { formats: ['wav'] } } } },
  { kind: 'piper', direction: 'tts', row: { name: 'local piper', provider: LOCAL_AUDIO_PROVIDER, modelId: 'piper:en_US-lessac-medium', metadata: { speech: { formats: ['wav'] } } } },
  { kind: 'mistral', direction: 'tts', row: { name: 'mistral voxtral speech', provider: 'mistral', modelId: 'voxtral-mini-tts-2603', metadata: { speech: { formats: ['mp3', 'wav', 'opus', 'flac', 'pcm'] } } } },
  { kind: 'openai', direction: 'tts', row: { name: 'openai gpt-4o-mini-tts', provider: 'openai', modelId: 'gpt-4o-mini-tts', metadata: { speech: { formats: ['mp3', 'wav', 'opus', 'flac', 'pcm'] } } } },
];

export function catalogEntry(kind: SpeechEngineKind, direction: SpeechDirection, size?: string): SpeechEngineEntry | undefined {
  const entry = SPEECH_ENGINE_CATALOG.find((e) => e.kind === kind && e.direction === direction);
  if (!entry || !size || kind !== 'fasterwhisper') return entry;
  return { ...entry, row: { ...entry.row, name: `local faster-whisper ${size}`, modelId: `faster-whisper:${size}` } };
}

/** Which engine family a row is (undefined: not a speech engine this build drives). */
export function engineKindOf(row: Pick<ModelConfigEntry, 'provider' | 'modelId'>): SpeechEngineKind | undefined {
  if (row.provider === LOCAL_AUDIO_PROVIDER) {
    if (row.modelId.startsWith('whisper.cpp:')) return 'whisper';
    if (row.modelId.startsWith('faster-whisper:')) return 'fasterwhisper';
    if (row.modelId.startsWith('kokoro:')) return 'kokoro';
    if (row.modelId.startsWith('piper:')) return 'piper';
    return undefined;
  }
  if (row.provider === 'mistral') return 'mistral';
  if (row.provider === 'openai') return 'openai';
  return undefined;
}

/** Which way a speech row works: transcription (stt) or speech (tts); undefined = not a speech engine. */
export function speechDirectionOf(row: Pick<ModelConfigEntry, 'provider' | 'modelId'>): SpeechDirection | undefined {
  const kind = engineKindOf(row);
  if (!kind) return undefined;
  if (kind === 'whisper' || kind === 'fasterwhisper') return 'stt';
  if (kind === 'kokoro' || kind === 'piper') return 'tts';
  const id = row.modelId.toLowerCase();
  if (/tts|speech/.test(id)) return 'tts';
  if (/transcri|whisper|voxtral/.test(id)) return 'stt';
  return undefined; // a chat model of a speech provider
}

/** A local engine runs on this machine (protection levels 3–4 may use it). */
export function isLocalSpeechRow(row: Pick<ModelConfigEntry, 'provider'>): boolean {
  return row.provider === LOCAL_AUDIO_PROVIDER;
}

/** What a row writes; the first is its default. */
export function speechFormats(row: Pick<ModelConfigEntry, 'provider' | 'modelId' | 'metadata'>): SpeechFormat[] {
  const declared = row.metadata?.speech?.formats;
  if (declared?.length) return declared;
  const kind = engineKindOf(row);
  return kind === 'kokoro' || kind === 'piper' ? ['wav'] : ['mp3', 'wav', 'opus', 'flac', 'pcm'];
}

/**
 * The row's own key (`apiKeyRef`: a vault name or `env:NAME`), or undefined
 * when the row names none — then the provider's install key is used. A ref
 * that names a key that is not there fails loud: billing another key would be wrong.
 */
async function rowApiKey(row: Pick<ModelConfigEntry, 'apiKeyRef' | 'name'>): Promise<string | undefined> {
  if (!row.apiKeyRef) return undefined;
  const { resolveCustomApiKey } = await import('@/services/provider-service');
  const key = await resolveCustomApiKey(row.apiKeyRef);
  if (!key) throw new Error(`The key "${row.apiKeyRef}" of model "${row.name}" is not set.`);
  return key;
}

/**
 * The speech-to-text adapter for `row`. `stream` = the live socket (needs a
 * streaming engine); `batch` = a whole clip.
 */
export async function sttEngineFor(row: ModelConfigEntry, opts: { language: string; streamWindowSeconds?: number }): Promise<STTEngine> {
  const stt = await import('./stt');
  const kind = engineKindOf(row);
  switch (kind) {
    case 'whisper': {
      const { whisperModelPath } = await import('./whisper');
      return new stt.WhisperEngine(row.metadata?.modelPath || whisperModelPath(), { language: opts.language, streamWindowSeconds: opts.streamWindowSeconds });
    }
    case 'fasterwhisper': {
      const size = row.modelId.slice('faster-whisper:'.length) as 'tiny' | 'base' | 'small' | 'medium' | 'large';
      return new stt.FasterWhisperEngine({ language: opts.language, model: size || 'small' });
    }
    case 'mistral':
      return new stt.MistralSTTEngine(row.modelId, { language: opts.language, apiKey: await rowApiKey(row), streamingModel: row.metadata?.speech?.streamingModel });
    case 'openai':
      return new stt.OpenAIRealtimeSTTEngine(row.metadata?.speech?.streamingModel || row.modelId, {
        language: opts.language, apiKey: await rowApiKey(row), batchModel: row.modelId,
      });
    default:
      throw new Error(`Model "${row.name}" (${row.provider}/${row.modelId}) is not a speech-to-text engine this install can run.`);
  }
}

/** The text-to-speech adapter for `row`, writing `format` (validated against `speechFormats`). */
export async function ttsEngineFor(row: ModelConfigEntry, opts: { voice?: string; format: SpeechFormat }): Promise<TTSEngine> {
  const tts = await import('./tts');
  const kind = engineKindOf(row);
  const format = opts.format as 'mp3' | 'wav' | 'opus' | 'flac' | 'pcm';
  switch (kind) {
    case 'kokoro':
      // The row names its voice (kokoro:<voice>); a voice asked for explicitly wins.
      return new tts.KokoroEngine(opts.voice || row.modelId.slice('kokoro:'.length) || undefined, { outputFormat: 'wav' });
    case 'piper': {
      const modelPath = row.metadata?.modelPath || `~/.local/share/piper/voices/${row.modelId.slice('piper:'.length)}.onnx`;
      return new tts.PiperEngine(modelPath, modelPath.replace(/\.onnx$/, '.json'), { outputFormat: 'wav' });
    }
    case 'mistral':
      return new tts.MistralTTSEngine(opts.voice, { outputFormat: format, model: row.modelId, apiKey: await rowApiKey(row) });
    case 'openai':
      return new tts.OpenAITTSEngine(opts.voice, { outputFormat: format, model: row.modelId, apiKey: await rowApiKey(row) });
    default:
      throw new Error(`Model "${row.name}" (${row.provider}/${row.modelId}) is not a text-to-speech engine this install can run.`);
  }
}

/**
 * Can this row run here, now? Local engines are probed (binary runs, model
 * present); cloud engines need a key. The reason says what to do.
 */
export async function speechRowAvailable(row: Pick<ModelConfigEntry, 'provider' | 'modelId' | 'apiKeyRef' | 'metadata'>): Promise<{ ok: true } | { ok: false; reason: string }> {
  const kind = engineKindOf(row);
  switch (kind) {
    case 'whisper': {
      const { probeWhisper } = await import('./whisper');
      const probe = await probeWhisper();
      if (!probe.binaryOk) return { ok: false, reason: `${probe.binaryReason ?? 'Local whisper is not installed'}. Run \`octi setup\` or install it from the Topics page.` };
      if (row.metadata?.modelPath) {
        const { fileAt } = await import('@/utils/fs-file');
        if (!(await fileAt(row.metadata.modelPath).exists())) return { ok: false, reason: `The whisper model file ${row.metadata.modelPath} is missing.` };
      } else if (!probe.modelOk) {
        return { ok: false, reason: 'The whisper model file is missing. Run `octi setup` to download it.' };
      }
      return { ok: true };
    }
    case 'fasterwhisper':
    case 'kokoro': {
      const { hasUv, kokoroModelsPresent, UV_INSTALL_HINT } = await import('./provision');
      if (!hasUv()) return { ok: false, reason: `\`uv\` is not installed. ${UV_INSTALL_HINT}` };
      if (kind === 'kokoro' && !(await kokoroModelsPresent())) return { ok: false, reason: 'Kokoro model files are missing. Run `octi setup` to download them.' };
      return { ok: true };
    }
    case 'piper': {
      if (!row.metadata?.modelPath) return { ok: false, reason: 'Piper needs its voice model path (the row\'s model path).' };
      const { fileAt } = await import('@/utils/fs-file');
      return (await fileAt(row.metadata.modelPath).exists()) ? { ok: true } : { ok: false, reason: `Piper voice not found at ${row.metadata.modelPath}.` };
    }
    case 'mistral':
    case 'openai': {
      if (row.apiKeyRef) {
        const { resolveCustomApiKey } = await import('@/services/provider-service');
        return (await resolveCustomApiKey(row.apiKeyRef)) ? { ok: true } : { ok: false, reason: `The model's key "${row.apiKeyRef}" is not set.` };
      }
      const has = kind === 'mistral'
        ? !!(await (await import('@/models/providers/mistral-provider')).getMistralApiKey())
        : !!(await (await import('@/models/providers/openai-provider')).getOpenAIApiKey());
      return has ? { ok: true } : { ok: false, reason: `No ${kind === 'mistral' ? 'Mistral' : 'OpenAI'} API key is configured.` };
    }
    default:
      return { ok: false, reason: `${row.provider}/${row.modelId} is not a speech engine this install can run.` };
  }
}

/**
 * Register an engine from the catalog as a model row and, when its lane has
 * no binding yet (or `makePrimary`), bind it there. What every installer and
 * the setup ends with, so an installed engine is used without another step —
 * but never silently replaces an engine someone chose.
 */
export async function useSpeechEngine(
  kind: SpeechEngineKind,
  direction: SpeechDirection,
  opts: { size?: string; modelPath?: string; makePrimary?: boolean } = {},
): Promise<{ row: ModelConfigEntry; bound: 'primary' | 'already-bound' | 'not-bound'; lane: 'transcription' | 'speech' }> {
  const entry = catalogEntry(kind, direction, opts.size);
  if (!entry) throw new Error(`No ${direction === 'stt' ? 'speech-to-text' : 'text-to-speech'} engine "${kind}"`);
  const { getModelRegistry } = await import('@/models/model-registry');
  const registry = getModelRegistry();
  const lane = direction === 'stt' ? 'transcription' as const : 'speech' as const;
  let row = await registry.getModel(entry.row.name);
  if (row && opts.modelPath && row.metadata?.modelPath !== opts.modelPath) {
    row = (await registry.updateModel(row.name, { metadata: { ...(row.metadata ?? {}), modelPath: opts.modelPath } })) ?? row;
  }
  if (!row) {
    row = await registry.registerModel({
      ...entry.row,
      supportsTools: false,
      supportsStreaming: false,
      supportsVision: false,
      metadata: { ...(entry.row.metadata ?? {}), ...(opts.modelPath ? { modelPath: opts.modelPath } : {}), capabilitiesDetectedAt: new Date().toISOString() },
    } as NewModelConfigEntry);
  }
  const current = await registry.getModelForTopic(lane);
  if (current?.name === row.name) return { row, bound: 'already-bound', lane };
  if (current && !opts.makePrimary) return { row, bound: 'not-bound', lane };
  if (current) {
    // The engine it replaces becomes the one backup, so nothing that worked
    // stops working; an older backup steps down.
    const backup = await registry.getBackupModelForTopic(lane);
    if (backup && backup.name !== current.name && backup.name !== row.name && backup.topicRoles?.[lane]) {
      const { [lane]: _dropped, ...rest } = backup.topicRoles;
      await registry.updateModel(backup.name, { topicRoles: rest });
    }
    await registry.updateModel(current.name, { topicRoles: { ...(current.topicRoles ?? {}), [lane]: 'backup' } });
  }
  row = await registry.updateModel(row.name, { topicRoles: { ...(row.topicRoles ?? {}), [lane]: 'primary' } }) ?? row;
  return { row, bound: 'primary', lane };
}
