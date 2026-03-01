import { spawn, type Subprocess } from 'bun';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

export interface WakeWordOptions {
  sensitivity?: number;  // 0.0 - 1.0 (higher = more sensitive, more false positives)
  sampleRate?: number;
  modelPath?: string;
}

export interface WakeWordDetection {
  keyword: string;
  confidence: number;
  timestamp: number;
}

export interface WakeWordEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  onDetection(callback: (detection: WakeWordDetection) => void): void;
  onError(callback: (error: Error) => void): void;
}

/**
 * Sherpa-ONNX based wake word detection
 */
export class SherpaWakeWordEngine extends EventEmitter implements WakeWordEngine {
  private modelPath: string;
  private keywords: string[];
  private options: WakeWordOptions;
  private process: Subprocess | null = null;
  private running = false;
  private log = logger.child({ component: 'wake-word-sherpa' });

  constructor(modelPath: string, keywords: string[], options: WakeWordOptions = {}) {
    super();
    this.modelPath = modelPath;
    this.keywords = keywords;
    this.options = {
      sensitivity: 0.5,
      sampleRate: 16000,
      ...options,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;

    const script = `
import sherpa_onnx
import sounddevice as sd
import numpy as np
import sys
import json

# Create keyword spotter
config = sherpa_onnx.KeywordSpotterConfig(
    tokens="${this.modelPath}/tokens.txt",
    encoder="${this.modelPath}/encoder.onnx",
    decoder="${this.modelPath}/decoder.onnx",
    joiner="${this.modelPath}/joiner.onnx",
    keywords_file="${this.modelPath}/keywords.txt",
    keywords_threshold=${this.options.sensitivity},
    num_trailing_blanks=1,
)

spotter = sherpa_onnx.KeywordSpotter(config)
stream = spotter.create_stream()

sample_rate = ${this.options.sampleRate}
samples_per_read = int(0.1 * sample_rate)  # 100ms chunks

def callback(indata, frames, time, status):
    if status:
        print(json.dumps({"error": str(status)}), file=sys.stderr)

    samples = np.frombuffer(indata, dtype=np.float32)
    stream.accept_waveform(sample_rate, samples)

    while spotter.is_ready(stream):
        spotter.decode_stream(stream)

    result = spotter.get_result(stream)
    if result:
        detection = {
            "type": "detection",
            "keyword": result,
            "confidence": 1.0,
            "timestamp": time.currentTime,
        }
        print(json.dumps(detection), flush=True)

print(json.dumps({"type": "ready"}), flush=True)

with sd.InputStream(samplerate=sample_rate, channels=1, dtype='float32',
                    blocksize=samples_per_read, callback=callback):
    while True:
        sd.sleep(1000)
`;

    const pythonPath = process.env.PYTHON_PATH || 'python3';

    this.process = spawn({
      cmd: [pythonPath, '-c', script],
      stdout: 'pipe',
      stderr: 'pipe',
    });

    this.running = true;
    this.log.info('Wake word detection started');

    // Process stdout for detections
    this.processOutput();

    // Process stderr for errors
    this.processErrors();
  }

  private async processOutput(): Promise<void> {
    if (!this.process) return;

    const reader = (this.process.stdout as any).getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const data = JSON.parse(line);

            if (data.type === 'ready') {
              this.log.info('Wake word engine ready');
              this.emit('ready');
            } else if (data.type === 'detection') {
              const detection: WakeWordDetection = {
                keyword: data.keyword,
                confidence: data.confidence,
                timestamp: data.timestamp,
              };
              this.log.info({ detection }, 'Wake word detected');
              this.emit('detection', detection);
            }
          } catch (e) {
            // Not JSON, log as is
            this.log.debug({ line }, 'Non-JSON output');
          }
        }
      }
    } catch (error) {
      if (this.running) {
        this.log.error({ error }, 'Error reading output');
        this.emit('error', error);
      }
    }
  }

  private async processErrors(): Promise<void> {
    if (!this.process) return;

    const reader = (this.process.stderr as any).getReader();
    const decoder = new TextDecoder();

    try {
      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        if (text.trim()) {
          this.log.warn({ stderr: text }, 'Stderr output');
        }
      }
    } catch {
      // Ignore stderr read errors
    }
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.process) {
      this.process.kill();
      this.process = null;
    }

    this.log.info('Wake word detection stopped');
  }

  onDetection(callback: (detection: WakeWordDetection) => void): void {
    this.on('detection', callback);
  }

  onError(callback: (error: Error) => void): void {
    this.on('error', callback);
  }
}

/**
 * Porcupine-like wake word engine using Picovoice
 * Note: Requires Picovoice access key
 */
export class PicovoiceWakeWordEngine extends EventEmitter implements WakeWordEngine {
  private accessKey: string;
  private keywords: string[];
  private options: WakeWordOptions;
  private process: Subprocess | null = null;
  private running = false;
  private log = logger.child({ component: 'wake-word-porcupine' });

  constructor(accessKey: string, keywords: string[], options: WakeWordOptions = {}) {
    super();
    this.accessKey = accessKey;
    this.keywords = keywords;
    this.options = {
      sensitivity: 0.5,
      sampleRate: 16000,
      ...options,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;

    const keywordArgs = this.keywords.map(k => `"${k}"`).join(', ');
    const sensitivities = this.keywords.map(() => this.options.sensitivity).join(', ');

    const script = `
import pvporcupine
import pvrecorder
import json
import sys

porcupine = pvporcupine.create(
    access_key="${this.accessKey}",
    keywords=[${keywordArgs}],
    sensitivities=[${sensitivities}],
)

recorder = pvrecorder.PvRecorder(
    device_index=-1,
    frame_length=porcupine.frame_length,
)

print(json.dumps({"type": "ready"}), flush=True)

recorder.start()

try:
    while True:
        pcm = recorder.read()
        keyword_index = porcupine.process(pcm)

        if keyword_index >= 0:
            detection = {
                "type": "detection",
                "keyword": [${keywordArgs}][keyword_index],
                "confidence": 1.0,
                "timestamp": 0,
            }
            print(json.dumps(detection), flush=True)
except KeyboardInterrupt:
    pass
finally:
    recorder.stop()
    recorder.delete()
    porcupine.delete()
`;

    const pythonPath = process.env.PYTHON_PATH || 'python3';

    this.process = spawn({
      cmd: [pythonPath, '-c', script],
      stdout: 'pipe',
      stderr: 'pipe',
    });

    this.running = true;
    this.log.info('Porcupine wake word detection started');

    // Reuse same output processing
    this.processOutput();
  }

  private async processOutput(): Promise<void> {
    if (!this.process) return;

    const reader = (this.process.stdout as any).getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const data = JSON.parse(line);

            if (data.type === 'ready') {
              this.emit('ready');
            } else if (data.type === 'detection') {
              this.emit('detection', {
                keyword: data.keyword,
                confidence: data.confidence,
                timestamp: Date.now(),
              });
            }
          } catch {
            // Not JSON
          }
        }
      }
    } catch (error) {
      if (this.running) {
        this.emit('error', error);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  onDetection(callback: (detection: WakeWordDetection) => void): void {
    this.on('detection', callback);
  }

  onError(callback: (error: Error) => void): void {
    this.on('error', callback);
  }
}

/**
 * Simple audio level based activation (VAD)
 * Useful as fallback when no wake word model available
 */
export class VADActivationEngine extends EventEmitter implements WakeWordEngine {
  private options: WakeWordOptions;
  private process: Subprocess | null = null;
  private running = false;
  private log = logger.child({ component: 'vad' });

  constructor(options: WakeWordOptions = {}) {
    super();
    this.options = {
      sensitivity: 0.3, // Energy threshold
      sampleRate: 16000,
      ...options,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;

    const script = `
import sounddevice as sd
import numpy as np
import json
import sys

sample_rate = ${this.options.sampleRate}
threshold = ${this.options.sensitivity}
chunk_duration = 0.1  # 100ms chunks
chunk_samples = int(sample_rate * chunk_duration)

# State for detecting speech start
silence_count = 0
speech_started = False

def callback(indata, frames, time, status):
    global silence_count, speech_started

    if status:
        print(json.dumps({"type": "error", "message": str(status)}), file=sys.stderr)

    # Calculate RMS energy
    samples = np.frombuffer(indata, dtype=np.float32)
    rms = np.sqrt(np.mean(samples ** 2))

    if rms > threshold:
        if not speech_started:
            speech_started = True
            detection = {
                "type": "detection",
                "keyword": "voice_activity",
                "confidence": float(rms),
                "timestamp": time.currentTime,
            }
            print(json.dumps(detection), flush=True)
        silence_count = 0
    else:
        silence_count += 1
        # Reset after 5 chunks of silence (500ms)
        if silence_count >= 5:
            speech_started = False

print(json.dumps({"type": "ready"}), flush=True)

with sd.InputStream(samplerate=sample_rate, channels=1, dtype='float32',
                    blocksize=chunk_samples, callback=callback):
    while True:
        sd.sleep(1000)
`;

    const pythonPath = process.env.PYTHON_PATH || 'python3';

    this.process = spawn({
      cmd: [pythonPath, '-c', script],
      stdout: 'pipe',
      stderr: 'pipe',
    });

    this.running = true;
    this.log.info('VAD activation started');

    this.processOutput();
  }

  private async processOutput(): Promise<void> {
    if (!this.process) return;

    const reader = (this.process.stdout as any).getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const data = JSON.parse(line);

            if (data.type === 'ready') {
              this.emit('ready');
            } else if (data.type === 'detection') {
              this.emit('detection', {
                keyword: data.keyword,
                confidence: data.confidence,
                timestamp: Date.now(),
              });
            }
          } catch {
            // Not JSON
          }
        }
      }
    } catch (error) {
      if (this.running) {
        this.emit('error', error);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  onDetection(callback: (detection: WakeWordDetection) => void): void {
    this.on('detection', callback);
  }

  onError(callback: (error: Error) => void): void {
    this.on('error', callback);
  }
}

/**
 * Factory function to create wake word engine
 */
export function createWakeWordEngine(
  type: 'sherpa' | 'porcupine' | 'vad' = 'vad',
  config: {
    modelPath?: string;
    accessKey?: string;
    keywords?: string[];
    options?: WakeWordOptions;
  } = {}
): WakeWordEngine {
  const { modelPath, accessKey, keywords = ['hey assistant'], options = {} } = config;

  switch (type) {
    case 'sherpa':
      if (!modelPath) throw new Error('modelPath required for Sherpa engine');
      return new SherpaWakeWordEngine(modelPath, keywords, options);
    case 'porcupine':
      if (!accessKey) throw new Error('accessKey required for Porcupine engine');
      return new PicovoiceWakeWordEngine(accessKey, keywords, options);
    case 'vad':
      return new VADActivationEngine(options);
    default:
      throw new Error(`Unknown wake word engine type: ${type}`);
  }
}

/**
 * Wake word detection service
 */
export class WakeWordDetector {
  private engine: WakeWordEngine;
  private log = logger.child({ component: 'wake-word' });

  constructor(engine: WakeWordEngine) {
    this.engine = engine;
  }

  static create(
    type: 'sherpa' | 'porcupine' | 'vad' = 'vad',
    config: {
      modelPath?: string;
      accessKey?: string;
      keywords?: string[];
      options?: WakeWordOptions;
    } = {}
  ): WakeWordDetector {
    const engine = createWakeWordEngine(type, config);
    return new WakeWordDetector(engine);
  }

  async start(): Promise<void> {
    this.log.info('Starting wake word detection');
    await this.engine.start();
  }

  async stop(): Promise<void> {
    this.log.info('Stopping wake word detection');
    await this.engine.stop();
  }

  onDetection(callback: (detection: WakeWordDetection) => void): void {
    this.engine.onDetection((detection) => {
      this.log.info({ keyword: detection.keyword }, 'Wake word detected');
      callback(detection);
    });
  }

  onError(callback: (error: Error) => void): void {
    this.engine.onError((error) => {
      this.log.error({ error }, 'Wake word error');
      callback(error);
    });
  }
}
