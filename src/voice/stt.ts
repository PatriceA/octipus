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
    let audioPath: string;
    let tempFile = false;

    if (Buffer.isBuffer(audio)) {
      audioPath = `/tmp/whisper-${Date.now()}.wav`;
      await Bun.write(audioPath, audio);
      tempFile = true;
    } else {
      audioPath = audio;
    }

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
      // Clean up temp files
      if (tempFile) {
        const audioFile = Bun.file(audioPath);
        if (await audioFile.exists()) await Bun.$`rm ${audioPath}`.quiet();
      }
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

/**
 * Factory function to create STT engine
 */
export function createSTTEngine(
  type: 'whisper-cpp' | 'faster-whisper' = 'faster-whisper',
  modelPathOrName: string,
  options: STTOptions = {}
): STTEngine {
  switch (type) {
    case 'whisper-cpp':
      return new WhisperEngine(modelPathOrName, options);
    case 'faster-whisper':
      return new FasterWhisperEngine(modelPathOrName, options);
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
    type: 'whisper-cpp' | 'faster-whisper' = 'faster-whisper',
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
