export type { STTEngine, STTOptions, TranscriptionResult } from './stt';
export { createSTTEngine, FasterWhisperEngine, SpeechToText, WhisperEngine } from './stt';
export type { TTSEngine, TTSOptions } from './tts';
export { CoquiTTSEngine, createTTSEngine, EdgeTTSEngine, PiperEngine, TextToSpeech } from './tts';
export type { WakeWordDetection, WakeWordEngine, WakeWordOptions } from './wake-word';
export {
  createWakeWordEngine,
  PicovoiceWakeWordEngine,
  SherpaWakeWordEngine,
  VADActivationEngine,
  WakeWordDetector,
} from './wake-word';

import { logger } from '../utils/logger';
import { SpeechToText, } from './stt';
import { TextToSpeech, } from './tts';
import { WakeWordDetector, } from './wake-word';

export interface VoiceServiceConfig {
  stt?: {
    type: 'whisper-cpp' | 'faster-whisper';
    model: string;
    language?: string;
  };
  tts?: {
    type: 'piper' | 'edge' | 'coqui';
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

  /**
   * Full voice interaction: listen for speech, transcribe, return text
   */
  async listen(durationMs: number = 5000): Promise<string> {
    if (!this.stt) {
      throw new Error('Speech-to-text not configured');
    }

    // Record audio for specified duration
    const audioPath = `/tmp/voice-listen-${Date.now()}.wav`;

    // Use arecord for Linux, sox for cross-platform
    const proc = Bun.spawn({
      cmd: [
        'arecord',
        '-f', 'S16_LE',
        '-r', '16000',
        '-c', '1',
        '-d', String(Math.ceil(durationMs / 1000)),
        audioPath,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });

    await proc.exited;

    try {
      const result = await this.stt.transcribe(audioPath);
      return result.text;
    } finally {
      await Bun.$`rm -f ${audioPath}`.quiet();
    }
  }

  /**
   * Conversational turn: listen, transcribe, get response, speak
   */
  async converse(
    getResponse: (text: string) => Promise<string>,
    listenDurationMs: number = 5000
  ): Promise<{ input: string; output: string }> {
    // Listen and transcribe
    const input = await this.listen(listenDurationMs);
    this.log.info({ input }, 'User said');

    // Get response
    const output = await getResponse(input);
    this.log.info({ output }, 'Octipus response');

    // Speak response
    if (this.tts) {
      const audio = await this.speak(output);
      // Play audio
      await this.playAudio(audio);
    }

    return { input, output };
  }

  /**
   * Play audio buffer
   */
  private async playAudio(audio: Buffer): Promise<void> {
    const tempPath = `/tmp/voice-play-${Date.now()}.wav`;
    await Bun.write(tempPath, audio);

    try {
      // Use aplay for Linux, afplay for macOS
      const player = process.platform === 'darwin' ? 'afplay' : 'aplay';
      const proc = Bun.spawn({
        cmd: [player, tempPath],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;
    } finally {
      await Bun.$`rm -f ${tempPath}`.quiet();
    }
  }

  /**
   * Clean up resources
   */
  async dispose(): Promise<void> {
    await this.stopListening();

    if (this.stt) {
      await this.stt.dispose();
    }
    if (this.tts) {
      await this.tts.dispose();
    }

    this.log.info('Voice service disposed');
  }
}
