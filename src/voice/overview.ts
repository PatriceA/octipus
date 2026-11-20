/**
 * Everything the Voice page shows about speech on this install, in one
 * answer: what serves each lane now, every speech engine registered (local,
 * cloud, your own server) with whether it can run and why not, what can be
 * installed from here, and any install in progress.
 */
import type { ModelConfigEntry } from '@/db/schema/models';
import { type SpeechInstallJob, speechInstallJobs } from './install-jobs';
import { FASTER_WHISPER_MODELS, hasUv, KOKORO_SIZE_NOTE } from './provision';
import { speechStatus } from './resolve';
import { liveRealtime, speechConfigOf } from './speech-hints';
import {
  engineKindOf, SPEECH_ENGINE_CATALOG, type SpeechDirection, speechDirectionOf, type SpeechEngineKind, speechFormats, speechRowAvailable, speechStaysLocal,
} from './speech-rows';

export interface SpeechEngineRow {
  name: string;
  direction: SpeechDirection;
  kind: SpeechEngineKind;
  modelId: string;
  endpoint: string | null;
  apiKeyRef: string | null;
  /** Its place on the lane, if any. */
  role: 'primary' | 'backup' | null;
  local: boolean;
  available: boolean;
  reason: string | null;
  /** What the engine takes (speech rows): voices, a description, a reference clip, speed, streaming. */
  speech: {
    voices: string[]; instructions: 'field' | 'prefix' | 'none'; cloning: boolean; speed: boolean; streams: boolean;
    sampleRate: number | null; formats: string[]; realtime: string | null; upload: 'any' | 'wav'; device: string | null;
  };
}

export interface SpeechCatalogEntry {
  kind: SpeechEngineKind;
  direction: SpeechDirection;
  label: string;
  local: boolean;
  /** Can be downloaded and set up from the Voice page. */
  installable: boolean;
  note: string;
  /** faster-whisper: the models offered (any other name can be typed). */
  sizes?: Array<{ id: string; download: string; ram: string; note: string }>;
}

const LABELS: Record<Exclude<SpeechEngineKind, 'compatible'>, { label: string; note: string; installable: boolean }> = {
  fasterwhisper: { label: 'faster-whisper', note: 'On this machine, free, private. Any Whisper model, including large-v3-turbo. Needs uv and ffmpeg.', installable: true },
  whisper: { label: 'whisper.cpp', note: 'On this machine, no Python. Built from source here: needs git, cmake and a compiler.', installable: true },
  kokoro: { label: 'Kokoro', note: `On this machine, natural voices in nine languages. ${KOKORO_SIZE_NOTE}. Needs uv.`, installable: true },
  piper: { label: 'Piper', note: 'On this machine, very small. You install the piper binary and a voice file yourself.', installable: false },
  mistral: { label: 'Voxtral (Mistral)', note: 'Cloud. Uses your Mistral key; streams live.', installable: false },
  openai: { label: 'OpenAI', note: 'Cloud. Uses your OpenAI key; streams live.', installable: false },
};

export interface SpeechOverview {
  hear: Awaited<ReturnType<typeof speechStatus>>;
  speak: Awaited<ReturnType<typeof speechStatus>>;
  engines: SpeechEngineRow[];
  catalog: SpeechCatalogEntry[];
  jobs: SpeechInstallJob[];
  host: { uv: boolean; ffmpeg: boolean };
}

async function describe(row: ModelConfigEntry, direction: SpeechDirection): Promise<SpeechEngineRow> {
  const lane = direction === 'stt' ? 'transcription' : 'speech';
  const available = await speechRowAvailable(row);
  const config = speechConfigOf(row);
  const kind = engineKindOf(row) as SpeechEngineKind;
  return {
    name: row.name,
    direction,
    kind,
    modelId: row.modelId,
    endpoint: row.endpoint ?? null,
    apiKeyRef: row.apiKeyRef ?? null,
    role: row.topicRoles?.[lane] === 'primary' || row.topicRoles?.[lane] === 'backup' ? row.topicRoles[lane] as 'primary' | 'backup' : null,
    local: await speechStaysLocal(row),
    available: available.ok,
    reason: available.ok ? null : available.reason,
    speech: {
      voices: config.voices ?? [],
      // The built-in engines take a preset voice only; OpenAI's newer model and compatible servers take a description.
      instructions: config.instructions ?? (kind === 'compatible' ? 'field' : 'none'),
      cloning: config.cloning ?? (kind === 'mistral' && direction === 'tts'),
      speed: config.speed ?? (kind !== 'mistral'),
      streams: config.streams ?? (kind === 'openai' && direction === 'tts'),
      sampleRate: config.sampleRate ?? null,
      formats: direction === 'tts' ? speechFormats(row) : [],
      // The live socket in use: none when the row turned off the one its model is known for.
      realtime: direction === 'stt' ? (liveRealtime(config)?.protocol ?? (kind === 'mistral' || kind === 'openai' ? kind : null)) : null,
      upload: config.upload ?? 'any',
      device: kind === 'fasterwhisper' ? (config.device ?? 'auto') : null,
    },
  };
}

export async function speechOverview(req: { userId?: string; allowHosted?: boolean } = {}): Promise<SpeechOverview> {
  const { getModelRegistry } = await import('@/models/model-registry');
  const { whichSync } = await import('@/utils/proc');
  const rows = (await getModelRegistry().getAllModels()).filter((r) => !r.ownerUserId);
  const engines: SpeechEngineRow[] = [];
  for (const row of rows) {
    const direction = speechDirectionOf(row);
    if (direction) engines.push(await describe(row, direction));
  }
  const [hear, speak] = await Promise.all([speechStatus('stt', req), speechStatus('tts', req)]);
  return {
    hear,
    speak,
    engines: engines.sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'primary' ? -1 : b.role === 'primary' ? 1 : a.role === 'backup' ? -1 : b.role === 'backup' ? 1 : 0)),
    catalog: SPEECH_ENGINE_CATALOG.map((entry) => {
      const meta = LABELS[entry.kind as Exclude<SpeechEngineKind, 'compatible'>];
      return {
        kind: entry.kind,
        direction: entry.direction,
        label: meta.label,
        local: entry.row.provider === 'local-audio',
        installable: meta.installable,
        note: meta.note,
        ...(entry.kind === 'fasterwhisper' ? { sizes: FASTER_WHISPER_MODELS.map((m) => ({ ...m })) } : {}),
      };
    }),
    jobs: speechInstallJobs(),
    host: { uv: hasUv(), ffmpeg: whichSync('ffmpeg') !== null },
  };
}
