import { spawnProcess as spawn } from '@/utils/proc';
import { EventEmitter } from 'events';
import { homedir } from 'node:os';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../utils/logger';
import { fileAt, removeFile, writeFileAt } from '@/utils/fs-file';

export interface TTSOptions {
  voice?: string;
  speed?: number;  // 0.5 - 2.0
  pitch?: number;  // 0.5 - 2.0
  volume?: number; // 0.0 - 1.0
  sampleRate?: number;
  outputFormat?: 'wav' | 'mp3' | 'ogg' | 'pcm' | 'flac' | 'opus';
}

export interface TTSEngine {
  synthesize(text: string): Promise<Buffer>;
  streamSynthesize(text: string): AsyncGenerator<Buffer>;
  getVoices(): Promise<string[]>;
  dispose(): Promise<void>;
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
    const outputPath = `/tmp/piper-${crypto.randomUUID()}.wav`;

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
        cmd: ['piper', ...args],
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
const KOKORO_VOICES = [
  'af_heart', 'af_sarah', 'af_bella', 'af_nicole', 'af_sky',
  'am_adam', 'am_michael', 'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis',
];

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
    const stamp = crypto.randomUUID();
    const inputPath = `/tmp/kokoro-${stamp}.txt`;
    const outputPath = `/tmp/kokoro-${stamp}.wav`;

    try {
      await writeFileAt(inputPath, text);

      const { kokoroModelDir } = await import('./provision');
      const worker = join(import.meta.dirname, 'kokoro_tts_worker.py');
      const proc = spawn({
        cmd: [
          'uv', 'run', '--python', '3.12', '--with', 'kokoro-onnx', '--with', 'soundfile',
          worker, inputPath, outputPath,
          '--model-dir', kokoroModelDir(),
          '--voice', this.options.voice || KOKORO_DEFAULT_VOICE,
          '--speed', String(this.options.speed ?? 1.0),
        ],
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`Kokoro failed: ${stderr || `exit ${exitCode}`}`);
      }

      const audioBuffer = await fileAt(outputPath).arrayBuffer();
      return Buffer.from(audioBuffer);
    } finally {
      await removeFile(inputPath);
      await removeFile(outputPath);
    }
  }

  async *streamSynthesize(text: string): AsyncGenerator<Buffer> {
    // ponytail: sentence-split like Piper; the CLI has no streaming mode.
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    for (const sentence of sentences) {
      yield await this.synthesize(sentence.trim());
    }
  }

  async getVoices(): Promise<string[]> {
    return KOKORO_VOICES;
  }

  async dispose(): Promise<void> {
    // No persistent process.
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
    this.model = MISTRAL_TTS_MODEL;
    // mp3 ≈3s end-to-end, pcm ≈0.8s. mp3 is the sane default for HTTP callers;
    // a latency-sensitive caller (telephony) should pass outputFormat: 'pcm'.
    this.options = { outputFormat: 'mp3', ...options, voice: voiceId || options.voice || MISTRAL_DEFAULT_VOICE };
  }

  private async apiKey(): Promise<string> {
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
        ...(this.options.voice ? { voice_id: this.options.voice } : {}),
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
    this.model = OPENAI_TTS_MODEL;
    this.options = { outputFormat: 'mp3', ...options, voice: voice || options.voice || OPENAI_DEFAULT_VOICE };
  }

  private async apiKey(): Promise<string> {
    const { getOpenAIApiKey } = await import('../models/providers/openai-provider');
    const key = await getOpenAIApiKey();
    if (!key) throw new Error('OpenAI API key not available. Set OPENAI_API_KEY or store it in the vault.');
    return key;
  }

  async synthesize(text: string): Promise<Buffer> {
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
        response_format: this.options.outputFormat || 'mp3',
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`OpenAI TTS failed (${response.status}): ${detail.slice(0, 500)}`);
    }
    return Buffer.from(await response.arrayBuffer());
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
 * Factory function to create TTS engine
 */
export function createTTSEngine(
  type: 'piper' | 'kokoro' | 'mistral' | 'openai' = 'mistral',
  modelOrVoice?: string,
  options: TTSOptions = {}
): TTSEngine {
  switch (type) {
    case 'piper':
      const modelPath = modelOrVoice || '~/.local/share/piper/voices/en_US-lessac-medium.onnx';
      const configPath = modelPath.replace('.onnx', '.json');
      return new PiperEngine(modelPath, configPath, options);
    case 'kokoro':
      return new KokoroEngine(modelOrVoice, options);
    case 'mistral':
      return new MistralTTSEngine(modelOrVoice, options);
    case 'openai':
      return new OpenAITTSEngine(modelOrVoice, options);
    default:
      throw new Error(`Unknown TTS engine type: ${type}`);
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

  static async create(
    type: 'piper' | 'kokoro' | 'mistral' | 'openai' = 'mistral',
    modelOrVoice?: string,
    options: TTSOptions = {}
  ): Promise<TextToSpeech> {
    const engine = createTTSEngine(type, modelOrVoice, options);
    return new TextToSpeech(engine);
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
