import { type Subprocess, spawn } from 'bun';
import { EventEmitter } from 'events';
import { dirname, resolve } from 'path';
import { logger } from '../utils/logger';

/** Resolve the bundled whisper-cpp binary shipped with the project */
function getBundledWhisperBinary(): string {
  // models/whisper/whisper-cpp relative to project root
  const projectRoot = resolve(dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '../..');
  return resolve(projectRoot, 'models/whisper/whisper-cpp');
}

/**
 * Transcode arbitrary audio to the only thing whisper.cpp decodes: 16 kHz mono
 * signed-16 WAV. Browser mics send webm/opus (and a Bluetooth headset may flip
 * between mono/stereo profiles); ffmpeg sniffs the container and `-ac 1`
 * downmixes deterministically, so the binary always gets a clean file. Returns
 * a new temp path the caller must delete.
 */
async function toWhisperWav(sourcePath: string): Promise<string> {
  const out = `/tmp/whisper-16k-${Date.now()}-${Math.round(performance.now())}.wav`;
  let proc: Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    proc = spawn({
      cmd: ['ffmpeg', '-nostdin', '-y', '-i', sourcePath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', out],
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch {
    // spawn throws if the binary is missing on PATH.
    throw new Error('ffmpeg is required for local whisper transcription but was not found. Install ffmpeg, or use a hosted STT model (voxtral-*, whisper-1).');
  }
  await proc.exited;
  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Audio conversion failed (ffmpeg exit ${proc.exitCode}): ${stderr.slice(-300)}`);
  }
  return out;
}

export interface STTOptions {
  model?: 'tiny' | 'base' | 'small' | 'medium' | 'large';
  language?: string;
  translate?: boolean;
  vadEnabled?: boolean;
  vadThreshold?: number;
}

export interface TranscriptionResult {
  text: string;
  segments: Array<{
    start: number;
    end: number;
    text: string;
    confidence: number;
  }>;
  language: string;
  duration: number;
}

export interface STTEngine {
  transcribe(audio: Buffer | string): Promise<TranscriptionResult>;
  streamTranscribe(stream: ReadableStream<Uint8Array>): AsyncGenerator<string>;
  dispose(): Promise<void>;
}

/**
 * Whisper.cpp based speech-to-text engine
 */
export class WhisperEngine extends EventEmitter implements STTEngine {
  private modelPath: string;
  private options: STTOptions;
  private process: Subprocess | null = null;

  constructor(modelPath: string, options: STTOptions = {}) {
    super();
    this.modelPath = modelPath;
    this.options = {
      model: 'base',
      language: 'en',
      translate: false,
      vadEnabled: true,
      vadThreshold: 0.5,
      ...options,
    };
  }

  /**
   * Transcribe audio file or buffer
   */
  async transcribe(audio: Buffer | string): Promise<TranscriptionResult> {
    const startTime = Date.now();

    // If buffer, write to temp file
    let sourcePath: string;
    let tempSource = false;

    if (Buffer.isBuffer(audio)) {
      sourcePath = `/tmp/whisper-src-${Date.now()}`;
      await Bun.write(sourcePath, audio);
      tempSource = true;
    } else {
      sourcePath = audio;
    }

    // Normalize to 16 kHz mono WAV — whisper.cpp decodes nothing else.
    const audioPath = await toWhisperWav(sourcePath);
    const jsonPath = `${audioPath}.json`;

    try {
      const binary = getBundledWhisperBinary();
      const args = [
        '-m', this.modelPath,
        '-f', audioPath,
        '-l', this.options.language!,
        '--output-json',
      ];

      if (this.options.translate) {
        args.push('--translate');
      }

      const proc = spawn({
        cmd: [binary, ...args],
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const exitCode = proc.exitCode;

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`Whisper failed (exit ${exitCode}): ${stderr}`);
      }

      // whisper-cli writes JSON to <audioPath>.json
      const jsonFile = Bun.file(jsonPath);
      if (!(await jsonFile.exists())) {
        throw new Error('Whisper did not produce JSON output');
      }

      const raw = JSON.parse(await jsonFile.text());

      // Parse whisper.cpp JSON format:
      //   { result: { language }, transcription: [{ timestamps: { from, to }, offsets: { from, to }, text }] }
      const transcription: Array<{ timestamps: { from: string; to: string }; offsets: { from: number; to: number }; text: string }> = raw.transcription || [];

      const fullText = transcription.map(t => t.text).join('').trim();
      const segments = transcription.map(t => ({
        start: t.offsets.from / 1000,
        end: t.offsets.to / 1000,
        text: t.text?.trim() || '',
        confidence: 1.0, // whisper.cpp JSON doesn't include per-segment confidence
      }));

      return {
        text: fullText,
        segments,
        language: raw.result?.language || this.options.language!,
        duration: (Date.now() - startTime) / 1000,
      };
    } finally {
      // Clean up temp files: the converted wav is always ours; the source only
      // when we wrote it from a buffer.
      if (tempSource) {
        const srcFile = Bun.file(sourcePath);
        if (await srcFile.exists()) await Bun.$`rm ${sourcePath}`.quiet();
      }
      const audioFile = Bun.file(audioPath);
      if (await audioFile.exists()) await Bun.$`rm ${audioPath}`.quiet();
      const jsonFile = Bun.file(jsonPath);
      if (await jsonFile.exists()) await Bun.$`rm ${jsonPath}`.quiet();
    }
  }

  /**
   * Stream transcription for real-time use
   */
  async *streamTranscribe(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const tempPath = `/tmp/whisper-stream-${Date.now()}.wav`;
    const chunks: Uint8Array[] = [];

    const reader = stream.getReader();
    let totalBytes = 0;
    const chunkThreshold = 16000 * 2 * 3; // 3 seconds of 16kHz 16-bit audio

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        chunks.push(value);
        totalBytes += value.length;

        // Process in chunks
        if (totalBytes >= chunkThreshold) {
          const audioData = Buffer.concat(chunks);
          chunks.length = 0;
          totalBytes = 0;

          // Write chunk and transcribe
          await Bun.write(tempPath, audioData);
          const result = await this.transcribe(tempPath);

          if (result.text) {
            yield result.text;
          }
        }
      }

      // Process remaining audio
      if (chunks.length > 0) {
        const audioData = Buffer.concat(chunks);
        await Bun.write(tempPath, audioData);
        const result = await this.transcribe(tempPath);

        if (result.text) {
          yield result.text;
        }
      }
    } finally {
      await Bun.file(tempPath).exists() &&
        await Bun.$`rm ${tempPath}`.quiet();
    }
  }

  async dispose(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}

/**
 * Faster-Whisper (Python) based speech-to-text engine
 * Uses CTranslate2 for faster inference
 */
export class FasterWhisperEngine extends EventEmitter implements STTEngine {
  private model: string;
  private options: STTOptions;
  private pythonPath: string;

  constructor(model: string = 'base', options: STTOptions = {}) {
    super();
    this.model = model;
    this.pythonPath = process.env.PYTHON_PATH || 'python3';
    this.options = {
      language: 'en',
      vadEnabled: true,
      vadThreshold: 0.5,
      ...options,
    };
  }

  async transcribe(audio: Buffer | string): Promise<TranscriptionResult> {
    const startTime = Date.now();

    let audioPath: string;
    let tempFile = false;

    if (Buffer.isBuffer(audio)) {
      audioPath = `/tmp/faster-whisper-${Date.now()}.wav`;
      await Bun.write(audioPath, audio);
      tempFile = true;
    } else {
      audioPath = audio;
    }

    try {
      // Python script for faster-whisper
      const script = `
import sys
import json
import os
from faster_whisper import WhisperModel

model = WhisperModel(os.environ["WHISPER_MODEL"], device="auto", compute_type="auto")
segments, info = model.transcribe(os.environ["WHISPER_AUDIO_PATH"], language=os.environ.get("WHISPER_LANGUAGE"))

result = {
    "text": "",
    "segments": [],
    "language": info.language,
}

for segment in segments:
    result["segments"].append({
        "start": segment.start,
        "end": segment.end,
        "text": segment.text,
        "confidence": segment.avg_logprob,
    })
    result["text"] += segment.text

print(json.dumps(result))
`;

      const proc = spawn({
        cmd: [this.pythonPath, '-c', script],
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          WHISPER_MODEL: this.model,
          WHISPER_AUDIO_PATH: audioPath,
          WHISPER_LANGUAGE: this.options.language || '',
        },
      });

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`Faster-Whisper failed: ${stderr}`);
      }

      const result = JSON.parse(output.trim());

      return {
        text: result.text?.trim() || '',
        segments: result.segments || [],
        language: result.language || this.options.language!,
        duration: (Date.now() - startTime) / 1000,
      };
    } finally {
      if (tempFile) {
        await Bun.file(audioPath).exists() &&
          await Bun.$`rm ${audioPath}`.quiet();
      }
    }
  }

  async *streamTranscribe(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    // Similar implementation to WhisperEngine
    const tempPath = `/tmp/faster-whisper-stream-${Date.now()}.wav`;
    const chunks: Uint8Array[] = [];

    const reader = stream.getReader();
    let totalBytes = 0;
    const chunkThreshold = 16000 * 2 * 3;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        chunks.push(value);
        totalBytes += value.length;

        if (totalBytes >= chunkThreshold) {
          const audioData = Buffer.concat(chunks);
          chunks.length = 0;
          totalBytes = 0;

          await Bun.write(tempPath, audioData);
          const result = await this.transcribe(tempPath);

          if (result.text) {
            yield result.text;
          }
        }
      }

      if (chunks.length > 0) {
        const audioData = Buffer.concat(chunks);
        await Bun.write(tempPath, audioData);
        const result = await this.transcribe(tempPath);

        if (result.text) {
          yield result.text;
        }
      }
    } finally {
      await Bun.file(tempPath).exists() &&
        await Bun.$`rm ${tempPath}`.quiet();
    }
  }

  async dispose(): Promise<void> {
    // No persistent process to clean up
  }
}

/** Mistral batch transcription model. */
const MISTRAL_STT_MODEL = 'voxtral-mini-latest';
/** Mistral realtime transcription model — `diarize` is not supported on this path. */
const MISTRAL_STT_REALTIME_MODEL = 'voxtral-mini-transcribe-realtime-2602';

/** Realtime expects headerless PCM at this shape. */
const REALTIME_SAMPLE_RATE = 16000;

/**
 * Strip a RIFF/WAVE header if present, returning raw PCM samples.
 *
 * Realtime wants headerless `pcm_s16le`, but `WhisperEngine.streamTranscribe`
 * conditioned callers to hand over WAV-framed bytes. Rather than resample here
 * (a much bigger job), we accept only audio that is already 16 kHz mono 16-bit
 * and fail loudly otherwise.
 */
export function stripWavHeader(chunk: Uint8Array): Uint8Array {
  if (chunk.length < 44) return chunk;
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const isRiff = chunk[0] === 0x52 && chunk[1] === 0x49 && chunk[2] === 0x46 && chunk[3] === 0x46; // "RIFF"
  if (!isRiff) return chunk;

  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  if (channels !== 1 || sampleRate !== REALTIME_SAMPLE_RATE || bitsPerSample !== 16) {
    throw new Error(
      `Mistral realtime transcription requires 16kHz mono 16-bit PCM; got ${sampleRate}Hz ${channels}ch ${bitsPerSample}-bit. Resample before streaming.`
    );
  }
  return chunk.subarray(44);
}

/**
 * Mistral (Voxtral) speech-to-text.
 *
 * - `transcribe()` → `POST /v1/audio/transcriptions` (multipart/form-data).
 * - `streamTranscribe()` → `wss://api.mistral.ai/v1/audio/transcriptions/realtime`,
 *   a JSON event protocol carrying base64 PCM frames.
 */
export class MistralSTTEngine extends EventEmitter implements STTEngine {
  private model: string;
  private options: STTOptions & { diarize?: boolean; contextBias?: string[] };

  constructor(model: string = MISTRAL_STT_MODEL, options: STTOptions & { diarize?: boolean; contextBias?: string[] } = {}) {
    super();
    this.model = model;
    this.options = { language: 'en', ...options };
  }

  private async apiKey(): Promise<string> {
    const { getMistralApiKey } = await import('../models/providers/mistral-provider');
    const key = await getMistralApiKey();
    if (!key) throw new Error('Mistral API key not available. Set MISTRAL_API_KEY or store it in the vault.');
    return key;
  }

  async transcribe(audio: Buffer | string): Promise<TranscriptionResult> {
    const startTime = Date.now();
    const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(await Bun.file(audio).arrayBuffer());
    const fileName = typeof audio === 'string' ? audio.split('/').pop()! : 'audio.wav';

    const form = new FormData();
    form.append('model', this.model);
    form.append('file', new Blob([new Uint8Array(buffer)]), fileName);
    if (this.options.language) form.append('language', this.options.language);
    if (this.options.diarize) form.append('diarize', 'true');
    for (const term of this.options.contextBias || []) form.append('context_bias', term);
    form.append('timestamp_granularities', 'segment');

    const response = await fetch('https://api.mistral.ai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.apiKey()}` },
      body: form,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Mistral transcription failed (${response.status}): ${detail.slice(0, 500)}`);
    }

    const raw = (await response.json()) as {
      text?: string;
      language?: string;
      segments?: Array<{ start: number; end: number; text: string }>;
    };

    return {
      text: (raw.text || '').trim(),
      // Mistral segments carry no per-segment confidence, same as whisper.cpp JSON.
      segments: (raw.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text?.trim() || '', confidence: 1.0 })),
      language: raw.language || this.options.language!,
      duration: (Date.now() - startTime) / 1000,
    };
  }

  async *streamTranscribe(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    if (this.options.diarize) {
      throw new Error('Mistral realtime transcription does not support diarization');
    }

    const url = `wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=${encodeURIComponent(MISTRAL_STT_REALTIME_MODEL)}`;
    // ponytail: Bun's WebSocket accepts a `headers` option, so no `ws` dependency.
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${await this.apiKey()}` } } as never);

    // Event queue: the socket pushes, the generator pulls.
    const queue: Array<Record<string, unknown>> = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let socketError: Error | null = null;
    let pumpError: Error | null = null;

    const push = (item: Record<string, unknown> | null) => {
      if (item) queue.push(item);
      else finished = true;
      wake?.();
      wake = null;
    };

    ws.addEventListener('message', (e) => {
      try {
        push(JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)));
      } catch {
        // Unknown frame — the protocol is forward-compatible, so ignore it.
      }
    });
    ws.addEventListener('error', () => { socketError = new Error('Mistral realtime websocket error'); push(null); });
    ws.addEventListener('close', () => push(null));

    await new Promise<void>((resolve, reject) => {
      if (ws.readyState === WebSocket.OPEN) return resolve();
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('Mistral realtime websocket failed to connect')), { once: true });
    });

    // Pump audio up while we read events down. Defaults are pcm_s16le @16kHz,
    // so no session.update is needed.
    const pump = (async () => {
      const reader = stream.getReader();
      // A WAV header spans the first 44 bytes, which may arrive split across
      // several chunks — accumulate before deciding whether to strip.
      let preamble: Uint8Array | null = new Uint8Array(0);
      const send = (pcm: Uint8Array) => {
        if (pcm.length) {
          ws.send(JSON.stringify({ type: 'input_audio.append', audio: Buffer.from(pcm).toString('base64') }));
        }
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (preamble) {
            const merged: Uint8Array = new Uint8Array(preamble.length + value.length);
            merged.set(preamble);
            merged.set(value, preamble.length);
            if (merged.length < 44) { preamble = merged; continue; }
            preamble = null;
            send(stripWavHeader(merged));
          } else {
            send(value);
          }
        }
        // Stream ended inside the preamble: too short to be a WAV header, so
        // it is raw PCM. stripWavHeader passes short buffers through.
        if (preamble) send(stripWavHeader(preamble));
        ws.send(JSON.stringify({ type: 'input_audio.flush' }));
        ws.send(JSON.stringify({ type: 'input_audio.end' }));
      } finally {
        reader.releaseLock();
      }
    })().catch((err: unknown) => {
      // If the uplink dies we never send `input_audio.end`, so the server never
      // sends `transcription.done` and the consumer below would await forever.
      // Wake it and let it rethrow.
      pumpError = err instanceof Error ? err : new Error(String(err));
      push(null);
    });

    try {
      while (true) {
        if (!queue.length) {
          if (finished) break;
          await new Promise<void>((resolve) => { wake = resolve; });
          continue;
        }
        const event = queue.shift()!;
        if (event.type === 'transcription.text.delta') {
          yield String(event.text ?? '');
        } else if (event.type === 'transcription.done') {
          break;
        } else if (event.type === 'error') {
          const detail = (event.error as { message?: string } | undefined)?.message || 'unknown error';
          throw new Error(`Mistral realtime transcription error: ${detail}`);
        }
      }
      if (pumpError) throw pumpError;
      if (socketError) throw socketError;
    } finally {
      if (ws.readyState === WebSocket.OPEN) ws.close();
      await pump;
    }
  }

  async dispose(): Promise<void> {
    // Stateless — the websocket is scoped to streamTranscribe().
  }
}

/**
 * Factory function to create STT engine
 */
export function createSTTEngine(
  type: 'whisper-cpp' | 'faster-whisper' | 'mistral' = 'faster-whisper',
  modelPathOrName: string,
  options: STTOptions = {}
): STTEngine {
  switch (type) {
    case 'whisper-cpp':
      return new WhisperEngine(modelPathOrName, options);
    case 'faster-whisper':
      return new FasterWhisperEngine(modelPathOrName, options);
    case 'mistral':
      return new MistralSTTEngine(modelPathOrName || MISTRAL_STT_MODEL, options);
    default:
      throw new Error(`Unknown STT engine type: ${type}`);
  }
}

/**
 * Speech-to-text service that manages STT engine
 */
export class SpeechToText {
  private engine: STTEngine;
  private log = logger.child({ component: 'stt' });

  constructor(engine: STTEngine) {
    this.engine = engine;
  }

  static async create(
    type: 'whisper-cpp' | 'faster-whisper' | 'mistral' = 'faster-whisper',
    modelPathOrName: string = 'base',
    options: STTOptions = {}
  ): Promise<SpeechToText> {
    const engine = createSTTEngine(type, modelPathOrName, options);
    return new SpeechToText(engine);
  }

  async transcribe(audio: Buffer | string): Promise<TranscriptionResult> {
    this.log.debug('Starting transcription');

    try {
      const result = await this.engine.transcribe(audio);
      this.log.info({
        text: result.text.substring(0, 100),
        duration: result.duration,
        language: result.language,
      }, 'Transcription complete');
      return result;
    } catch (error) {
      this.log.error({ error }, 'Transcription failed');
      throw error;
    }
  }

  async *streamTranscribe(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    this.log.debug('Starting stream transcription');

    try {
      for await (const text of this.engine.streamTranscribe(stream)) {
        this.log.debug({ text: text.substring(0, 50) }, 'Stream chunk');
        yield text;
      }
    } catch (error) {
      this.log.error({ error }, 'Stream transcription failed');
      throw error;
    }
  }

  async dispose(): Promise<void> {
    await this.engine.dispose();
  }
}
