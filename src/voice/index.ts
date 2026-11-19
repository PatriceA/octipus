export type { STTEngine, STTOptions, TranscriptionResult } from './stt';
export { MistralSTTEngine, OpenAIRealtimeSTTEngine, SpeechToText, WhisperEngine } from './stt';
export type { TTSEngine, TTSOptions } from './tts';
export { KokoroEngine, MistralTTSEngine, OpenAITTSEngine, PiperEngine, TextToSpeech } from './tts';

import { type ChildProcessHandle as Subprocess, spawnProcess } from '@/utils/proc';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../utils/logger';
import type { SpeechToText } from './stt';
import type { TextToSpeech } from './tts';
import { fileAt, removeFile, writeFileAt } from '@/utils/fs-file';

/**
 * Voice on this machine, for a client process (the TUI): the microphone is
 * recorded and the reply played here; the engines are whatever they are
 * given — the TUI hands in ones that go through the server's speech lanes
 * (src/voice/remote-engines.ts), so there is one configuration to speak of.
 */
export class VoiceService {
  private stt: SpeechToText | null = null;
  private tts: TextToSpeech | null = null;
  private log = logger.child({ component: 'voice-service' });
  /** Push-to-talk capture, toggled by startRecording()/stopRecordingAndTranscribe(). */
  private recordProc: Subprocess | null = null;
  private recordPath: string | null = null;

  constructor(stt?: SpeechToText, tts?: TextToSpeech) {
    this.stt = stt || null;
    this.tts = tts || null;
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
   * Synthesize text to audio
   */
  async speak(text: string): Promise<Buffer> {
    if (!this.tts) {
      throw new Error('Text-to-speech not configured');
    }

    return this.tts.synthesize(text);
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
    this.recordPath = join(tmpdir(), `voice-ptt-${Date.now()}.wav`);
    this.recordProc = spawnProcess({
      command: 'arecord',
      args: ['-f', 'S16_LE', '-r', '16000', '-c', '1', this.recordPath],
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
    const tempPath = join(tmpdir(), `voice-play-${Date.now()}.wav`);
    await writeFileAt(tempPath, audio);

    try {
      // Use aplay for Linux, afplay for macOS
      const player = process.platform === 'darwin' ? 'afplay' : 'aplay';
      const proc = spawnProcess({
        command: player,
        args: [tempPath],
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
