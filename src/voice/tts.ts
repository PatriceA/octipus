import { spawn, } from 'bun';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

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
    const outputPath = `/tmp/piper-${Date.now()}.wav`;

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
      const audioBuffer = await Bun.file(outputPath).arrayBuffer();
      return Buffer.from(audioBuffer);
    } finally {
      await Bun.file(outputPath).exists() &&
        await Bun.$`rm ${outputPath}`.quiet();
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
      const result = await Bun.$`ls ~/.local/share/piper/voices/*.onnx 2>/dev/null || echo ""`.text();
      return result.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  async dispose(): Promise<void> {
    // No persistent process
  }
}

/**
 * Edge TTS engine (Microsoft Edge online TTS)
 */
export class EdgeTTSEngine extends EventEmitter implements TTSEngine {
  private options: TTSOptions;

  constructor(options: TTSOptions = {}) {
    super();
    this.options = {
      voice: 'en-US-AriaNeural',
      speed: 1.0,
      pitch: 1.0,
      volume: 1.0,
      outputFormat: 'mp3',
      ...options,
    };
  }

  async synthesize(text: string): Promise<Buffer> {
    const outputPath = `/tmp/edge-tts-${Date.now()}.mp3`;

    try {
      const rate = this.options.speed
        ? `${this.options.speed > 1 ? '+' : ''}${Math.round((this.options.speed - 1) * 100)}%`
        : '+0%';

      const pitch = this.options.pitch
        ? `${this.options.pitch > 1 ? '+' : ''}${Math.round((this.options.pitch - 1) * 100)}Hz`
        : '+0Hz';

      const args = [
        '--voice', this.options.voice!,
        '--rate', rate,
        '--pitch', pitch,
        '--write-media', outputPath,
        '--text', text,
      ];

      const proc = spawn({
        cmd: ['edge-tts', ...args],
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`Edge TTS failed: ${stderr}`);
      }

      const audioBuffer = await Bun.file(outputPath).arrayBuffer();
      return Buffer.from(audioBuffer);
    } finally {
      await Bun.file(outputPath).exists() &&
        await Bun.$`rm ${outputPath}`.quiet();
    }
  }

  async *streamSynthesize(text: string): AsyncGenerator<Buffer> {
    const outputPath = `/tmp/edge-tts-stream-${Date.now()}.mp3`;

    const rate = this.options.speed
      ? `${this.options.speed > 1 ? '+' : ''}${Math.round((this.options.speed - 1) * 100)}%`
      : '+0%';

    const args = [
      '--voice', this.options.voice!,
      '--rate', rate,
      '--write-media', outputPath,
      '--text', text,
    ];

    const proc = spawn({
      cmd: ['edge-tts', ...args],
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Stream output as it's written
    let lastSize = 0;
    const checkInterval = 100;

    while (true) {
      await Bun.sleep(checkInterval);

      const file = Bun.file(outputPath);
      if (await file.exists()) {
        const size = file.size;
        if (size > lastSize) {
          const buffer = await file.arrayBuffer();
          const newData = buffer.slice(lastSize);
          lastSize = size;
          yield Buffer.from(newData);
        }
      }

      // Check if process finished
      try {
        const exitCode = proc.exitCode;
        if (exitCode !== null) {
          // Get any remaining data
          if (await Bun.file(outputPath).exists()) {
            const buffer = await Bun.file(outputPath).arrayBuffer();
            if (buffer.byteLength > lastSize) {
              yield Buffer.from(buffer.slice(lastSize));
            }
          }
          break;
        }
      } catch {
        // Process still running
      }
    }

    await Bun.file(outputPath).exists() &&
      await Bun.$`rm ${outputPath}`.quiet();
  }

  async getVoices(): Promise<string[]> {
    try {
      const proc = spawn({
        cmd: ['edge-tts', '--list-voices'],
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const output = await new Response(proc.stdout).text();
      await proc.exited;

      // Parse voice names from output
      const voices: string[] = [];
      for (const line of output.split('\n')) {
        const match = line.match(/Name:\s*(.+)/);
        if (match) {
          voices.push(match[1].trim());
        }
      }
      return voices;
    } catch {
      return [];
    }
  }

  async dispose(): Promise<void> {
    // No persistent process
  }
}

/**
 * Coqui TTS engine (local neural TTS)
 */
export class CoquiTTSEngine extends EventEmitter implements TTSEngine {
  private model: string;
  private options: TTSOptions;
  private pythonPath: string;

  constructor(model: string = 'tts_models/en/ljspeech/tacotron2-DDC', options: TTSOptions = {}) {
    super();
    this.model = model;
    this.pythonPath = process.env.PYTHON_PATH || 'python3';
    this.options = {
      speed: 1.0,
      outputFormat: 'wav',
      ...options,
    };
  }

  async synthesize(text: string): Promise<Buffer> {
    const outputPath = `/tmp/coqui-${Date.now()}.wav`;

    try {
      const args = [
        '-m', 'TTS',
        '--text', text,
        '--model_name', this.model,
        '--out_path', outputPath,
      ];

      const proc = spawn({
        cmd: [this.pythonPath, ...args],
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`Coqui TTS failed: ${stderr}`);
      }

      const audioBuffer = await Bun.file(outputPath).arrayBuffer();
      return Buffer.from(audioBuffer);
    } finally {
      await Bun.file(outputPath).exists() &&
        await Bun.$`rm ${outputPath}`.quiet();
    }
  }

  async *streamSynthesize(text: string): AsyncGenerator<Buffer> {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

    for (const sentence of sentences) {
      const audio = await this.synthesize(sentence.trim());
      yield audio;
    }
  }

  async getVoices(): Promise<string[]> {
    try {
      const proc = spawn({
        cmd: [this.pythonPath, '-m', 'TTS', '--list_models'],
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const output = await new Response(proc.stdout).text();
      await proc.exited;

      // Parse model names
      return output.trim().split('\n').filter(line => line.includes('tts_models'));
    } catch {
      return [];
    }
  }

  async dispose(): Promise<void> {
    // No persistent process
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
    // ponytail: sentence-split like Piper/Coqui. The endpoint does support
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

/**
 * Factory function to create TTS engine
 */
export function createTTSEngine(
  type: 'piper' | 'edge' | 'coqui' | 'mistral' = 'edge',
  modelOrVoice?: string,
  options: TTSOptions = {}
): TTSEngine {
  switch (type) {
    case 'piper':
      const modelPath = modelOrVoice || '~/.local/share/piper/voices/en_US-lessac-medium.onnx';
      const configPath = modelPath.replace('.onnx', '.json');
      return new PiperEngine(modelPath, configPath, options);
    case 'edge':
      return new EdgeTTSEngine({ voice: modelOrVoice || 'en-US-AriaNeural', ...options });
    case 'coqui':
      return new CoquiTTSEngine(modelOrVoice, options);
    case 'mistral':
      return new MistralTTSEngine(modelOrVoice, options);
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
    type: 'piper' | 'edge' | 'coqui' | 'mistral' = 'edge',
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
