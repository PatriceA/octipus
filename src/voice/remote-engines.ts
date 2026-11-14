/**
 * Speech through the server's lanes, for a client process (the TUI): the
 * audio is recorded and played here, transcribed and spoken by whatever the
 * install binds to the Transcription and Speech lanes (`/api/voice/*`). One
 * source of truth — a TUI no longer runs its own whisper.
 */
import { fileAt } from '@/utils/fs-file';
import type { STTEngine, TranscriptionResult } from './stt';
import type { TTSEngine } from './tts';

export interface RemoteVoiceTarget {
  /** e.g. http://127.0.0.1:3005 */
  baseUrl: string;
  token: string;
}

async function call(target: RemoteVoiceTarget, path: string, body: unknown): Promise<Response> {
  const res = await fetch(`${target.baseUrl}/api/voice${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  return res;
}

export class RemoteSTTEngine implements STTEngine {
  constructor(private readonly target: RemoteVoiceTarget) {}

  async transcribe(audio: Buffer | string): Promise<TranscriptionResult> {
    const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(await fileAt(audio).arrayBuffer());
    const format = typeof audio === 'string' ? (audio.split('.').pop() || 'wav') : 'wav';
    const res = await call(this.target, '/transcribe', { audio: buffer.toString('base64'), format });
    const body = (await res.json().catch(() => ({}))) as { text?: string; language?: string; duration?: number; error?: string };
    if (!res.ok || body.error) throw new Error(body.error || `Transcription failed (${res.status})`);
    return { text: body.text ?? '', segments: [], language: body.language ?? '', duration: body.duration ?? 0 };
  }

  async *streamTranscribe(): AsyncGenerator<string> {
    throw new Error('Streaming transcription is not available from a client process');
  }

  async dispose(): Promise<void> {}
}

export class RemoteTTSEngine implements TTSEngine {
  constructor(private readonly target: RemoteVoiceTarget, private readonly format: 'wav' | 'mp3' = 'wav') {}

  async synthesize(text: string): Promise<Buffer> {
    // The player plays this format; an engine that cannot write it says so instead of sending noise.
    const res = await call(this.target, '/speak', { text: text.slice(0, 5000), format: this.format });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || `Speech failed (${res.status})`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async *streamSynthesize(text: string): AsyncGenerator<Buffer> {
    yield await this.synthesize(text);
  }

  async getVoices(): Promise<string[]> {
    return [];
  }

  async dispose(): Promise<void> {}
}
