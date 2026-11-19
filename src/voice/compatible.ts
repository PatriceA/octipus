/**
 * Speech on any OpenAI-compatible server (docs/VOICE.md → Your own speech
 * server): `POST /v1/audio/transcriptions` and `POST /v1/audio/speech` at the
 * model row's own endpoint, with the row's own key. This is what makes a
 * speech model a matter of configuration instead of code: Speaches, vLLM and
 * vLLM-Omni, LocalAI, NVIDIA NeMo-Speech / NIM, Groq, DeepInfra and the like
 * all speak it.
 *
 * What differs between models rides on the row (`metadata.speech`, with the
 * known defaults of `speech-hints.ts`): how a voice description is passed,
 * whether a reference clip is taken, the sample rate, extra request fields,
 * whether a clip must be uploaded as WAV, and the realtime socket if any.
 */
import { EventEmitter } from 'events';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelConfigEntry } from '@/db/schema/models';
import { fileAt, writeFileAt } from '@/utils/fs-file';
import { logger } from '@/utils/logger';
import { FrameAccumulator } from './audio-codec';
import type { SpeechConfig } from './speech-hints';
import {
  nemoRealtimeProtocol, openAiRealtimeProtocol, pcm16kMonoToWav, type STTEngine, type STTOptions, streamRealtimeWs,
  stripNonSpeech, toWhisperWav, type TranscriptionResult,
} from './stt';
import { bodyChunks, evenPcm, type TTSEngine, type TTSOptions } from './tts';

const log = logger.child({ component: 'speech-compatible' });

/** Where a row's speech requests go, and what authenticates them. */
export interface SpeechEndpoint {
  /** The API root, ending in `/v1`. */
  baseUrl: string;
  headers: Record<string, string>;
  query: Record<string, string>;
}

type EndpointRow = Pick<ModelConfigEntry, 'name' | 'endpoint' | 'apiKeyRef' | 'metadata'>;

/**
 * The endpoint of a speech row: its `endpoint` (with or without `/v1`), the
 * key its `apiKeyRef` names (none for a keyless local server) and the auth
 * scheme and extra headers of `metadata.customProvider`. A key that is named
 * but not set fails loud: sending the request unauthenticated would only turn
 * it into the server's 401.
 */
export async function speechEndpointOf(row: EndpointRow): Promise<SpeechEndpoint> {
  if (!row.endpoint) throw new Error(`Model "${row.name}" has no endpoint URL.`);
  const trimmed = row.endpoint.replace(/\/+$/, '');
  const baseUrl = /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
  const headers: Record<string, string> = { ...(row.metadata?.customProvider?.extraHeaders ?? {}) };
  const query: Record<string, string> = {};
  if (row.apiKeyRef) {
    const { resolveCustomApiKey } = await import('@/services/provider-service');
    const key = await resolveCustomApiKey(row.apiKeyRef);
    if (!key) throw new Error(`The key "${row.apiKeyRef}" of model "${row.name}" is not set.`);
    const auth = row.metadata?.customProvider?.auth ?? { type: 'bearer' as const };
    if (auth.type === 'header' && auth.headerName) headers[auth.headerName] = key;
    else if (auth.type === 'query' && auth.paramName) query[auth.paramName] = key;
    else headers.Authorization = `Bearer ${key}`;
  }
  return { baseUrl, headers, query };
}

function url(endpoint: SpeechEndpoint, path: string, scheme?: 'ws'): string {
  const full = new URL(`${endpoint.baseUrl}${path}`);
  for (const [k, v] of Object.entries(endpoint.query)) full.searchParams.set(k, v);
  if (scheme === 'ws') full.protocol = full.protocol === 'https:' ? 'wss:' : 'ws:';
  return full.toString();
}

/** Languages are stored as `en` or `en-US`; `auto` and empty mean "let the model detect it". */
function languageParam(language: string | undefined): string | undefined {
  return language && language.toLowerCase() !== 'auto' ? language : undefined;
}

/**
 * `fetch`, with a failure that says which server could not be reached and
 * why: the bare "fetch failed" names neither, and this is the error someone
 * setting up their own speech server reads.
 */
async function request(target: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(target, init);
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const host = new URL(target).host;
    throw new Error(`The speech server at ${host} could not be reached: ${cause?.code || cause?.message || (err as Error).message}`);
  }
}

async function failure(what: string, response: Response): Promise<Error> {
  const detail = await response.text().catch(() => '');
  return new Error(`${what} failed (${response.status}): ${detail.slice(0, 500) || response.statusText}`);
}

// ── Speech to text ───────────────────────────────────────────────────────────

interface VerboseTranscription {
  text?: string;
  language?: string;
  duration?: number;
  segments?: Array<{ start: number; end: number; text: string }>;
  words?: Array<{ word: string; start: number; end: number }>;
}

export class CompatibleSTTEngine extends EventEmitter implements STTEngine {
  readonly live: boolean;

  constructor(
    private readonly endpoint: SpeechEndpoint,
    private readonly model: string,
    private readonly config: SpeechConfig,
    private readonly options: STTOptions = {},
  ) {
    super();
    this.live = !!config.realtime;
  }

  async transcribe(audio: Buffer | string): Promise<TranscriptionResult> {
    const started = Date.now();
    // A clip is read from a file: the name carries the container, and a
    // server that takes WAV only gets it transcoded first.
    const source = typeof audio === 'string' ? audio : join(tmpdir(), `stt-${crypto.randomUUID()}.wav`);
    let upload = source;
    try {
      if (typeof audio !== 'string') await writeFileAt(source, audio);
      if (this.config.upload === 'wav') upload = await toWhisperWav(source);
      const bytes = Buffer.from(await fileAt(upload).arrayBuffer());
      const name = upload === source ? (source.split('/').pop() || 'audio.wav') : 'audio.wav';
      const raw = await this.post(bytes, name);
      const text = stripNonSpeech(raw.text || '').trim();
      const segments = raw.segments?.length
        ? raw.segments.map((s) => ({ start: s.start, end: s.end, text: stripNonSpeech(s.text || '').trim(), confidence: 1.0 }))
        // Word times only (NeMo): one segment over the words.
        : raw.words?.length && text ? [{ start: raw.words[0].start, end: raw.words[raw.words.length - 1].end, text, confidence: 1.0 }] : [];
      return {
        text,
        segments: segments.filter((s) => s.text),
        language: raw.language || this.options.language || '',
        duration: (Date.now() - started) / 1000,
      };
    } finally {
      if (upload !== source) await rm(upload, { force: true });
      if (typeof audio !== 'string') await rm(source, { force: true });
    }
  }

  /**
   * `verbose_json` carries segment times, which `transcribe_audio` reports.
   * A server that does not know it answers 400/422: asked again for plain
   * `json`, once, and the reason is logged.
   */
  private async post(bytes: Buffer, fileName: string): Promise<VerboseTranscription> {
    const send = async (format: 'verbose_json' | 'json'): Promise<Response> => {
      const form = new FormData();
      form.append('model', this.model);
      form.append('file', new Blob([new Uint8Array(bytes)]), fileName);
      form.append('response_format', format);
      const language = languageParam(this.options.language);
      if (language) form.append('language', language);
      return request(url(this.endpoint, '/audio/transcriptions'), { method: 'POST', headers: this.endpoint.headers, body: form });
    };
    let response = await send('verbose_json');
    if (response.status === 400 || response.status === 422) {
      const detail = await response.text().catch(() => '');
      if (!/response_format|verbose/i.test(detail)) throw new Error(`Transcription failed (${response.status}): ${detail.slice(0, 500)}`);
      log.info({ model: this.model, detail: detail.slice(0, 200) }, 'Speech server has no verbose_json; asking for json');
      response = await send('json');
    }
    if (!response.ok) throw await failure('Transcription', response);
    return (await response.json()) as VerboseTranscription;
  }

  async *streamTranscribe(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const realtime = this.config.realtime;
    if (realtime?.protocol === 'nemo') {
      yield* streamRealtimeWs(nemoRealtimeProtocol({
        url: realtime.url || url(this.endpoint, '/audio/transcriptions/realtime', 'ws'),
        headers: this.endpoint.headers,
        language: languageParam(this.options.language),
        sampleRate: 16000,
      }), stream);
      return;
    }
    if (realtime?.protocol === 'openai') {
      const base = realtime.url || url(this.endpoint, '/realtime', 'ws');
      const target = new URL(base);
      if (!target.searchParams.has('intent')) target.searchParams.set('intent', 'transcription');
      yield* streamRealtimeWs(openAiRealtimeProtocol({
        url: target.toString(),
        headers: this.endpoint.headers,
        name: 'Speech server',
        model: this.config.streamingModel || this.model,
        language: languageParam(this.options.language),
        sampleRate: realtime.sampleRate ?? 24000,
      }), stream);
      return;
    }
    // No realtime socket: fixed windows, each sent as a WAV clip.
    const cfg = this.options.streamWindowSeconds;
    const acc = new FrameAccumulator(Math.round(16000 * 2 * (typeof cfg === 'number' && cfg > 0 ? cfg : 2)));
    const reader = stream.getReader();
    const flush = async (pcm: Uint8Array): Promise<string> => stripNonSpeech((await this.post(pcm16kMonoToWav(pcm), 'audio.wav')).text || '').trim();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const window of acc.push(value)) {
          const text = await flush(window);
          if (text) yield text;
        }
      }
      const tail = acc.flush();
      if (tail) {
        const text = await flush(tail);
        if (text) yield text;
      }
    } finally {
      reader.releaseLock();
    }
  }

  async dispose(): Promise<void> {
    // Stateless: a socket is scoped to streamTranscribe().
  }
}

// ── Text to speech ───────────────────────────────────────────────────────────

/** A reference clip as the data URI speech servers take in `ref_audio`. */
function dataUri(clip: { data: Buffer; mimeType: string }): string {
  return `data:${clip.mimeType};base64,${clip.data.toString('base64')}`;
}

/**
 * The request body for one piece of text: the OpenAI fields, then what this
 * model takes on top (a voice description as a field or a text prefix, a
 * reference clip, speed, the row's extra fields).
 */
export function speechRequestBody(model: string, config: SpeechConfig, options: TTSOptions, text: string, format: string): Record<string, unknown> {
  const describe = options.instructions?.trim();
  const mode = config.instructions ?? 'field';
  const body: Record<string, unknown> = {
    model,
    // VoxCPM reads a voice description from a parenthesised prefix on the text itself.
    input: describe && mode === 'prefix' ? `(${describe.replace(/[()]/g, ' ').trim()})${text}` : text,
    // The field is required by the API even where a model ignores it.
    voice: options.voice || config.voice || 'default',
    response_format: format,
    ...(config.extraBody ?? {}),
    ...(options.extraBody ?? {}),
  };
  if (describe && mode === 'field') body.instructions = describe;
  if (options.refAudio && config.cloning !== false) {
    body.ref_audio = dataUri(options.refAudio);
    if (options.refText) body.ref_text = options.refText;
  }
  if (options.speed && options.speed !== 1 && config.speed !== false) body.speed = options.speed;
  return body;
}

export class CompatibleTTSEngine extends EventEmitter implements TTSEngine {
  readonly pcmSampleRate: number;
  /** Set only when the server streams: a caller without it reads a whole WAV. */
  streamPcm?: (text: string) => AsyncGenerator<Buffer>;

  constructor(
    private readonly endpoint: SpeechEndpoint,
    private readonly model: string,
    private readonly config: SpeechConfig,
    private readonly options: TTSOptions = {},
  ) {
    super();
    this.pcmSampleRate = config.sampleRate ?? 24000;
    if (config.streams) this.streamPcm = (text) => this.pcmStream(text);
  }

  private async request(text: string, format: string, stream: boolean): Promise<Response> {
    const response = await request(url(this.endpoint, '/audio/speech'), {
      method: 'POST',
      headers: { ...this.endpoint.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...speechRequestBody(this.model, this.config, this.options, text, format), ...(stream ? { stream: true } : {}) }),
    });
    if (!response.ok) throw await failure('Speech synthesis', response);
    return response;
  }

  async synthesize(text: string): Promise<Buffer> {
    return Buffer.from(await (await this.request(text, this.options.outputFormat || 'wav', false)).arrayBuffer());
  }

  async *streamSynthesize(text: string): AsyncGenerator<Buffer> {
    yield await this.synthesize(text);
  }

  /**
   * `stream: true` with PCM. A server answers with the raw samples as they
   * are generated, or with server-sent `speech.audio.delta` events carrying
   * them in base64; both are read here.
   */
  private async *pcmStream(text: string): AsyncGenerator<Buffer> {
    const response = await this.request(text, 'pcm', true);
    if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
      yield* evenPcm(bodyChunks(response));
      return;
    }
    yield* evenPcm(sseAudio(response));
  }

  async getVoices(): Promise<string[]> {
    if (this.config.voices?.length) return this.config.voices;
    // Servers that keep named voices list them here (vLLM-Omni, Speaches); the others answer 404.
    const response = await fetch(url(this.endpoint, '/audio/voices'), { headers: this.endpoint.headers }).catch(() => null);
    if (!response?.ok) return [];
    const raw = (await response.json().catch(() => null)) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { voices?: unknown[]; data?: unknown[]; items?: unknown[] } | null)?.voices
      ?? (raw as { data?: unknown[] } | null)?.data ?? (raw as { items?: unknown[] } | null)?.items ?? [];
    return (list as unknown[])
      .map((v) => (typeof v === 'string' ? v : (v as { id?: string; voice_id?: string; name?: string }).id ?? (v as { voice_id?: string }).voice_id ?? (v as { name?: string }).name))
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
  }

  async dispose(): Promise<void> {
    // Stateless.
  }
}

/** The audio of a server-sent speech stream: `speech.audio.delta` events, base64 PCM in `audio` (or `delta`). */
async function* sseAudio(response: Response): AsyncGenerator<Buffer> {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of bodyChunks(response)) {
    pending += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = pending.search(/\r?\n\r?\n/)) >= 0) {
      const event = pending.slice(0, end);
      pending = pending.slice(end).replace(/^\r?\n\r?\n/, '');
      const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!data || data === '[DONE]') continue;
      let parsed: { type?: string; audio?: string; delta?: string; error?: { message?: string } | string };
      try { parsed = JSON.parse(data) as typeof parsed; } catch { continue; } // a keep-alive comment or a partial frame
      if (parsed.error) throw new Error(`Speech synthesis failed: ${typeof parsed.error === 'string' ? parsed.error : parsed.error.message ?? 'unknown error'}`);
      const audio = parsed.audio ?? parsed.delta;
      if (typeof audio === 'string' && audio) yield Buffer.from(audio, 'base64');
    }
  }
}
