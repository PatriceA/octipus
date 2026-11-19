import { spawnProcess as spawn } from '@/utils/proc';
import { EventEmitter } from 'events';
import { homedir, tmpdir } from 'node:os';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../utils/logger';
import { fileAt, removeFile } from '@/utils/fs-file';
import { ResidentWorker } from './resident-worker';

export interface TTSOptions {
  voice?: string;
  speed?: number;  // 0.5 - 2.0
  pitch?: number;  // 0.5 - 2.0
  volume?: number; // 0.0 - 1.0
  sampleRate?: number;
  outputFormat?: 'wav' | 'mp3' | 'ogg' | 'pcm' | 'flac' | 'opus';
  /** Cloud engines: the model of the row bound to the Speech lane. */
  model?: string;
  /** Cloud engines: the key of the model row (its apiKeyRef); unset = the provider's install key. */
  apiKey?: string;
  /** How the voice should sound or the line be delivered (a voice profile's description). */
  instructions?: string;
  /** A reference clip to speak in the voice of, with what is said in it. */
  refAudio?: { data: Buffer; mimeType: string };
  refText?: string;
  /** Extra request fields of the model row, sent as they are. */
  extraBody?: Record<string, unknown>;
}

export interface TTSEngine {
  synthesize(text: string): Promise<Buffer>;
  streamSynthesize(text: string): AsyncGenerator<Buffer>;
  /**
   * Mono s16le PCM at `pcmSampleRate`, as the engine generates it. Only
   * engines that really stream have it; the others are read through a WAV
   * (src/voice/resolve.ts `streamSpeechWithLane`).
   */
  streamPcm?(text: string): AsyncGenerator<Buffer>;
  readonly pcmSampleRate?: number;
  getVoices(): Promise<string[]>;
  dispose(): Promise<void>;
}

/** Read a response body as it arrives. */
export async function* bodyChunks(response: Response): AsyncGenerator<Buffer> {
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value?.length) yield Buffer.from(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * PCM bytes arrive in arbitrary chunks; a 16-bit sample must not be split
 * across two of them, or everything after plays as noise.
 */
export async function* evenPcm(chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let carry: Buffer | null = null;
  for await (const chunk of chunks) {
    const data: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
    const even = data.length & ~1;
    carry = even < data.length ? data.subarray(even) : null;
    if (even) yield data.subarray(0, even);
  }
}

/**
 * Piper TTS engine (local, fast, high-quality)
 */
export class PiperEngine extends EventEmitter implements TTSEngine {
  private modelPath: string;
  private configPath: string;
  private options: TTSOptions;

  constructor(modelPath: string, configPath: string, options: TTSOptions = {}) {
    super();
    this.modelPath = modelPath;
    this.configPath = configPath;
    this.options = {
      speed: 1.0,
      volume: 1.0,
      sampleRate: 22050,
      outputFormat: 'wav',
      ...options,
    };
  }

  async synthesize(text: string): Promise<Buffer> {
    const outputPath = join(tmpdir(), `piper-${crypto.randomUUID()}.wav`);

    try {
      const args = [
        '--model', this.modelPath,
        '--config', this.configPath,
        '--output_file', outputPath,
      ];

      if (this.options.speed && this.options.speed !== 1.0) {
        args.push('--length_scale', String(1.0 / this.options.speed));
      }

      const proc = spawn({
        command: 'piper',
        args,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // Write text to stdin
      const writer = (proc.stdin as any).getWriter();
      await writer.write(new TextEncoder().encode(text));
      await writer.close();

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`Piper failed: ${stderr}`);
      }

      // Read output file
      const audioBuffer = await fileAt(outputPath).arrayBuffer();
      return Buffer.from(audioBuffer);
    } finally {
      await fileAt(outputPath).exists() &&
        await removeFile(outputPath);
    }
  }

  async *streamSynthesize(text: string): AsyncGenerator<Buffer> {
    // Piper doesn't natively support streaming, so we split by sentences
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

    for (const sentence of sentences) {
      const audio = await this.synthesize(sentence.trim());
      yield audio;
    }
  }

  async getVoices(): Promise<string[]> {
    // Piper voices are model files, return available models
    try {
      // Read the directory directly rather than shelling out to `ls` — the
      // glob was the only reason a shell was involved.
      const dir = join(homedir(), '.local/share/piper/voices');
      const entries = await readdir(dir);
      return entries.filter((f) => f.endsWith('.onnx')).map((f) => join(dir, f));
    } catch {
      return [];
    }
  }

  async dispose(): Promise<void> {
    // No persistent process
  }
}

/**
 * Kokoro TTS engine (local, ONNX, no API key). Runs the `kokoro-onnx` runtime
 * (ONNX, no torch) through `uv run` + a bundled worker — no global install, the
 * same self-contained pattern as FasterWhisperEngine. Kokoro-82M leads open
 * local TTS on quality in 2026 while running faster-than-real-time on CPU; Piper
 * stays as the tiny/RPi fallback. Model files are provisioned by `octi setup`
 * (installKokoro in provision.ts) into kokoroModelDir().
 *
 * Voices are baked into the model (fixed set, no cloning), so `getVoices`
 * returns a static list rather than scanning the filesystem like Piper.
 */
const KOKORO_DEFAULT_VOICE = 'af_sarah';
/** Shown when the worker cannot be asked (Kokoro not installed yet). */
const KOKORO_VOICES = [
  'af_heart', 'af_sarah', 'af_bella', 'af_nicole', 'af_sky',
  'am_adam', 'am_michael', 'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis',
];

/** A Kokoro voice names its language in its first letter (`af_` American, `ff_` French, …). */
const KOKORO_LANG: Record<string, string> = {
  a: 'en-us', b: 'en-gb', e: 'es', f: 'fr-fr', h: 'hi', i: 'it', j: 'ja', p: 'pt-br', z: 'cmn',
};

/** One resident worker per model directory: the model loads once, not per sentence. */
const kokoroWorkers = new Map<string, ResidentWorker>();
async function kokoroWorker(): Promise<ResidentWorker> {
  const { kokoroModelDir } = await import('./provision');
  const dir = kokoroModelDir();
  let worker = kokoroWorkers.get(dir);
  if (!worker) {
    worker = new ResidentWorker('Kokoro', 'uv', [
      'run', '--python', '3.12', '--with', 'kokoro-onnx', '--with', 'soundfile',
      join(import.meta.dirname, 'kokoro_tts_worker.py'), '--model-dir', dir,
    ]);
    kokoroWorkers.set(dir, worker);
  }
  return worker;
}

/** Stop the resident Kokoro workers (shutdown, tests). */
export async function stopKokoroWorkers(): Promise<void> {
  const all = [...kokoroWorkers.values()];
  kokoroWorkers.clear();
  for (const w of all) await w.stop();
}

export class KokoroEngine extends EventEmitter implements TTSEngine {
  private options: TTSOptions;

  constructor(voice?: string, options: TTSOptions = {}) {
    super();
    this.options = {
      speed: 1.0,
      sampleRate: 24000, // Kokoro synthesises at 24 kHz
      outputFormat: 'wav',
      ...options,
      voice: voice || options.voice || KOKORO_DEFAULT_VOICE,
    };
  }

  async synthesize(text: string): Promise<Buffer> {
    const outputPath = join(tmpdir(), `kokoro-${crypto.randomUUID()}.wav`);
    const voice = this.options.voice || KOKORO_DEFAULT_VOICE;
    try {
      await (await kokoroWorker()).request({
        text, out: outputPath, voice, speed: this.options.speed ?? 1.0, lang: KOKORO_LANG[voice[0]] ?? 'en-us',
      });
      return Buffer.from(await fileAt(outputPath).arrayBuffer());
    } finally {
      await removeFile(outputPath);
    }
  }

  async *streamSynthesize(text: string): AsyncGenerator<Buffer> {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    for (const sentence of sentences) {
      yield await this.synthesize(sentence.trim());
    }
  }

  async getVoices(): Promise<string[]> {
    try {
      const reply = await (await kokoroWorker()).request<{ voices?: string[] }>({ voices: true });
      return reply.voices?.length ? reply.voices : KOKORO_VOICES;
    } catch (err) {
      logger.debug({ err }, 'Kokoro voices could not be listed; showing the built-in list');
      return KOKORO_VOICES;
    }
  }

  async dispose(): Promise<void> {
    // The worker is resident (shared); it stops itself when idle.
  }
}

const MISTRAL_TTS_MODEL = 'voxtral-mini-tts-2603';
/**
 * Voxtral TTS rejects a request with no voice ("Either ref_audio or voice must
 * be provided"), so a caller that doesn't pick one still needs a valid default —
 * otherwise every `/speak` 500s and voice-out silently degrades to text.
 */
const MISTRAL_DEFAULT_VOICE = 'en_paul_neutral';

/**
 * Mistral (Voxtral) text-to-speech via `POST /v1/audio/speech`.
 *
 * Note the endpoint returns JSON `{ audio_data: <base64> }` — NOT a raw audio
 * body like OpenAI's identically-named endpoint.
 */
export class MistralTTSEngine extends EventEmitter implements TTSEngine {
  private model: string;
  private options: TTSOptions;

  constructor(voiceId?: string, options: TTSOptions = {}) {
    super();
    this.model = options.model || MISTRAL_TTS_MODEL;
    // mp3 ≈3s end-to-end, pcm ≈0.8s. mp3 is the sane default for HTTP callers;
    // a latency-sensitive caller (telephony) should pass outputFormat: 'pcm'.
    this.options = { outputFormat: 'mp3', ...options, voice: voiceId || options.voice || MISTRAL_DEFAULT_VOICE };
  }

  private async apiKey(): Promise<string> {
    if (this.options.apiKey) return this.options.apiKey;
    const { getMistralApiKey } = await import('../models/providers/mistral-provider');
    const key = await getMistralApiKey();
    if (!key) throw new Error('Mistral API key not available. Set MISTRAL_API_KEY or store it in the vault.');
    return key;
  }

  async synthesize(text: string): Promise<Buffer> {
    const response = await fetch('https://api.mistral.ai/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.apiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        response_format: this.options.outputFormat || 'mp3',
        // A reference clip speaks in that voice instead of a preset one.
        ...(this.options.refAudio
          ? { ref_audio: this.options.refAudio.data.toString('base64') }
          : this.options.voice ? { voice_id: this.options.voice } : {}),
        ...(this.options.extraBody ?? {}),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Mistral TTS failed (${response.status}): ${detail.slice(0, 500)}`);
    }

    const { audio_data: audioData } = (await response.json()) as { audio_data?: string };
    if (!audioData) throw new Error('Mistral TTS returned no audio_data');
    return Buffer.from(audioData, 'base64');
  }

  async *streamSynthesize(text: string): AsyncGenerator<Buffer> {
    // ponytail: sentence-split like Piper. The endpoint does support
    // `stream: true` over SSE — wire that up when a latency-bound caller exists.
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    for (const sentence of sentences) {
      yield await this.synthesize(sentence.trim());
    }
  }

  async getVoices(): Promise<string[]> {
    const response = await fetch('https://api.mistral.ai/v1/audio/voices', {
      headers: { Authorization: `Bearer ${await this.apiKey()}` },
    });
    if (!response.ok) return [];
    const raw = (await response.json()) as { items?: Array<{ id: string }> };
    return (raw.items || []).map((v) => v.id);
  }

  async dispose(): Promise<void> {
    // Stateless.
  }
}

const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
const OPENAI_DEFAULT_VOICE = 'alloy';

/**
 * OpenAI text-to-speech via `POST /v1/audio/speech`.
 *
 * Unlike Mistral's identically-named endpoint, OpenAI returns the audio as a
 * raw response body (not JSON base64), so `synthesize` just reads the bytes.
 */
export class OpenAITTSEngine extends EventEmitter implements TTSEngine {
  private model: string;
  private options: TTSOptions;

  constructor(voice?: string, options: TTSOptions = {}) {
    super();
    this.model = options.model || OPENAI_TTS_MODEL;
    this.options = { outputFormat: 'mp3', ...options, voice: voice || options.voice || OPENAI_DEFAULT_VOICE };
  }

  private async apiKey(): Promise<string> {
    if (this.options.apiKey) return this.options.apiKey;
    const { getOpenAIApiKey } = await import('../models/providers/openai-provider');
    const key = await getOpenAIApiKey();
    if (!key) throw new Error('OpenAI API key not available. Set OPENAI_API_KEY or store it in the vault.');
    return key;
  }

  /** OpenAI writes 24 kHz mono s16le for `response_format: 'pcm'`. */
  readonly pcmSampleRate = 24000;

  private async request(text: string, format: string): Promise<Response> {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.apiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        voice: this.options.voice || OPENAI_DEFAULT_VOICE,
        response_format: format,
        ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
        ...(this.options.speed && this.options.speed !== 1 ? { speed: this.options.speed } : {}),
        ...(this.options.extraBody ?? {}),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`OpenAI TTS failed (${response.status}): ${detail.slice(0, 500)}`);
    }
    return response;
  }

  async synthesize(text: string): Promise<Buffer> {
    return Buffer.from(await (await this.request(text, this.options.outputFormat || 'mp3')).arrayBuffer());
  }

  /** The body is sent as it is generated: read it as it arrives. */
  async *streamPcm(text: string): AsyncGenerator<Buffer> {
    yield* evenPcm(bodyChunks(await this.request(text, 'pcm')));
  }

  async *streamSynthesize(text: string): AsyncGenerator<Buffer> {
    // ponytail: sentence-split like the other engines; wire OpenAI's SSE
    // streaming here if a latency-bound caller needs it.
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    for (const sentence of sentences) {
      yield await this.synthesize(sentence.trim());
    }
  }

  async getVoices(): Promise<string[]> {
    // OpenAI's TTS voices are a fixed, undocumented-via-API set.
    return ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'];
  }

  async dispose(): Promise<void> {
    // Stateless.
  }
}

/**
 * Text-to-speech service that manages TTS engine
 */
export class TextToSpeech {
  private engine: TTSEngine;
  private log = logger.child({ component: 'tts' });

  constructor(engine: TTSEngine) {
    this.engine = engine;
  }

  async synthesize(text: string): Promise<Buffer> {
    this.log.debug({ textLength: text.length }, 'Starting synthesis');

    try {
      const audio = await this.engine.synthesize(text);
      this.log.info({
        textLength: text.length,
        audioSize: audio.length,
      }, 'Synthesis complete');
      return audio;
    } catch (error) {
      this.log.error({ error }, 'Synthesis failed');
      throw error;
    }
  }

  async *streamSynthesize(text: string): AsyncGenerator<Buffer> {
    this.log.debug({ textLength: text.length }, 'Starting stream synthesis');

    try {
      for await (const audio of this.engine.streamSynthesize(text)) {
        this.log.debug({ chunkSize: audio.length }, 'Stream chunk');
        yield audio;
      }
    } catch (error) {
      this.log.error({ error }, 'Stream synthesis failed');
      throw error;
    }
  }

  async getVoices(): Promise<string[]> {
    return this.engine.getVoices();
  }

  async dispose(): Promise<void> {
    await this.engine.dispose();
  }
}
