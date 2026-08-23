export type { STTEngine, STTOptions, TranscriptionResult } from './stt';
export { createSTTEngine, MistralSTTEngine, OpenAIRealtimeSTTEngine, SpeechToText, WhisperEngine } from './stt';
export type { TTSEngine, TTSOptions } from './tts';
export { createTTSEngine, KokoroEngine, MistralTTSEngine, OpenAITTSEngine, PiperEngine, TextToSpeech } from './tts';
export type { WakeWordDetection, WakeWordEngine, WakeWordOptions } from './wake-word';
export {
  createWakeWordEngine,
  PicovoiceWakeWordEngine,
  SherpaWakeWordEngine,
  VADActivationEngine,
  WakeWordDetector,
} from './wake-word';

import { type ChildProcessHandle as Subprocess, spawnProcess } from '@/utils/proc';
import { logger } from '../utils/logger';
import { SpeechToText, } from './stt';
import { TextToSpeech, } from './tts';
import { WakeWordDetector, } from './wake-word';
import { fileAt, removeFile, writeFileAt } from '@/utils/fs-file';

export interface VoiceServiceConfig {
  stt?: {
    type: 'whisper-cpp' | 'mistral' | 'openai';
    model: string;
    language?: string;
  };
  tts?: {
    type: 'piper' | 'kokoro' | 'mistral' | 'openai';
    voice?: string;
    speed?: number;
  };
  wakeWord?: {
    type: 'sherpa' | 'porcupine' | 'vad';
    modelPath?: string;
    accessKey?: string;
    keywords?: string[];
    sensitivity?: number;
  };
}

/**
 * Unified voice service that combines STT, TTS, and wake word detection
 */
export class VoiceService {
  private stt: SpeechToText | null = null;
  private tts: TextToSpeech | null = null;
  private wakeWord: WakeWordDetector | null = null;
  private log = logger.child({ component: 'voice-service' });
  private listening = false;
  /** Push-to-talk capture, toggled by startRecording()/stopRecordingAndTranscribe(). */
  private recordProc: Subprocess | null = null;
  private recordPath: string | null = null;

  constructor(
    stt?: SpeechToText,
    tts?: TextToSpeech,
    wakeWord?: WakeWordDetector
  ) {
    this.stt = stt || null;
    this.tts = tts || null;
    this.wakeWord = wakeWord || null;
  }

  static async create(config: VoiceServiceConfig): Promise<VoiceService> {
    let stt: SpeechToText | undefined;
    let tts: TextToSpeech | undefined;
    let wakeWord: WakeWordDetector | undefined;

    if (config.stt) {
      stt = await SpeechToText.create(
        config.stt.type,
        config.stt.model,
        { language: config.stt.language }
      );
    }

    if (config.tts) {
      tts = await TextToSpeech.create(
        config.tts.type,
        config.tts.voice,
        { speed: config.tts.speed }
      );
    }

    if (config.wakeWord) {
      wakeWord = WakeWordDetector.create(config.wakeWord.type, {
        modelPath: config.wakeWord.modelPath,
        accessKey: config.wakeWord.accessKey,
        keywords: config.wakeWord.keywords,
        options: { sensitivity: config.wakeWord.sensitivity },
      });
    }

    return new VoiceService(stt, tts, wakeWord);
  }

  /**
   * Start listening for wake word
   */
  async startListening(onActivation: () => void): Promise<void> {
    if (!this.wakeWord) {
      throw new Error('Wake word detection not configured');
    }

    this.listening = true;
    this.log.info('Starting voice listening');

    this.wakeWord.onDetection(() => {
      this.log.info('Wake word detected, activating');
      onActivation();
    });

    this.wakeWord.onError((error) => {
      this.log.error({ error }, 'Wake word error');
    });

    await this.wakeWord.start();
  }

  /**
   * Stop listening for wake word
   */
  async stopListening(): Promise<void> {
    if (this.wakeWord && this.listening) {
      await this.wakeWord.stop();
      this.listening = false;
      this.log.info('Stopped voice listening');
    }
  }

  /**
   * Transcribe audio to text
   */
  async transcribe(audio: Buffer | string): Promise<string> {
    if (!this.stt) {
      throw new Error('Speech-to-text not configured');
    }

    const result = await this.stt.transcribe(audio);
    return result.text;
  }

  /**
   * Stream transcription from audio stream
   */
  async *streamTranscribe(audioStream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    if (!this.stt) {
      throw new Error('Speech-to-text not configured');
    }

    for await (const text of this.stt.streamTranscribe(audioStream)) {
      yield text;
    }
  }

  /**
   * Synthesize text to audio
   */
  async speak(text: string): Promise<Buffer> {
    if (!this.tts) {
      throw new Error('Text-to-speech not configured');
    }

    return this.tts.synthesize(text);
  }

  /**
   * Stream synthesized audio
   */
  async *streamSpeak(text: string): AsyncGenerator<Buffer> {
    if (!this.tts) {
      throw new Error('Text-to-speech not configured');
    }

    for await (const chunk of this.tts.streamSynthesize(text)) {
      yield chunk;
    }
  }

  /**
   * Get available TTS voices
   */
  async getVoices(): Promise<string[]> {
    if (!this.tts) {
      return [];
    }
    return this.tts.getVoices();
  }

  /** True while a push-to-talk capture is in progress. */
  get recording(): boolean {
    return this.recordProc !== null;
  }

  /**
   * Push-to-talk: start capturing mic audio until `stopRecordingAndTranscribe()`.
   * No fixed duration — the caller ends it on the next keypress.
   * ponytail: arecord-only capture (Linux/ALSA); no cross-platform mic. Throws if
   * the binary is missing.
   */
  startRecording(): void {
    if (!this.stt) throw new Error('Speech-to-text not configured');
    if (this.recordProc) return; // already recording — ignore double-press
    this.recordPath = `/tmp/voice-ptt-${Date.now()}.wav`;
    this.recordProc = spawnProcess({
      cmd: ['arecord', '-f', 'S16_LE', '-r', '16000', '-c', '1', this.recordPath],
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }

  /**
   * Stop the push-to-talk capture and transcribe it. Returns '' if nothing was
   * captured. arecord finalizes the WAV header on SIGTERM, so the file is valid.
   */
  async stopRecordingAndTranscribe(): Promise<string> {
    const proc = this.recordProc;
    const path = this.recordPath;
    this.recordProc = null;
    this.recordPath = null;
    if (!proc || !path || !this.stt) return '';
    proc.kill(); // SIGTERM — arecord traps it and closes the WAV cleanly
    await proc.exited;
    try {
      const file = fileAt(path);
      // arecord writes a 44-byte WAV header up front; a file at/under that size
      // means no samples were captured (no mic, or an ALSA device error). Surface
      // that clearly instead of letting ffmpeg fail on an empty/absent file.
      if (!(await file.exists()) || file.size <= 44) {
        const stderr = proc.stderr ? await new Response(proc.stderr as ReadableStream).text().catch(() => '') : '';
        const detail = stderr.trim().split('\n').pop();
        throw new Error(`no audio captured — check your microphone / ALSA device${detail ? `: ${detail}` : ''}`);
      }
      const result = await this.stt.transcribe(path);
      return result.text.trim();
    } finally {
      await removeFile(path);
    }
  }

  /** Speak text aloud (TTS → aplay/afplay). No-op if TTS isn't configured. */
  async say(text: string): Promise<void> {
    if (!this.tts || !text.trim()) return;
    const audio = await this.speak(text);
    await this.playAudio(audio);
  }

  /**
   * Play audio buffer
   */
  private async playAudio(audio: Buffer): Promise<void> {
    const tempPath = `/tmp/voice-play-${Date.now()}.wav`;
    await writeFileAt(tempPath, audio);

    try {
      // Use aplay for Linux, afplay for macOS
      const player = process.platform === 'darwin' ? 'afplay' : 'aplay';
      const proc = spawnProcess({
        cmd: [player, tempPath],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;
    } finally {
      await removeFile(tempPath);
    }
  }

  /**
   * Clean up resources
   */
  async dispose(): Promise<void> {
    await this.stopListening();

    // Tear down an in-progress push-to-talk capture so quitting mid-record
    // doesn't orphan the arecord process or leak its temp WAV.
    if (this.recordProc) {
      try { this.recordProc.kill(); } catch { /* already gone */ }
      this.recordProc = null;
    }
    if (this.recordPath) {
      await removeFile(this.recordPath);
      this.recordPath = null;
    }

    if (this.stt) {
      await this.stt.dispose();
    }
    if (this.tts) {
      await this.tts.dispose();
    }

    this.log.info('Voice service disposed');
  }
}
