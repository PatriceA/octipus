import type { CompletionOptions, CompletionResult, StreamChunk } from '../litellm-client';
import type { ModelProvider, ProviderHealthStatus } from './interface';

/**
 * Local speech engines (whisper.cpp, faster-whisper, Kokoro, Piper) as a
 * provider, so their rows are ordinary model rows: bound to the
 * Transcription / Speech lanes, listed, health-checked, and counted as local
 * for protection levels. They are driven by src/voice/speech-rows.ts, never
 * through chat completion.
 */
export class LocalAudioProvider implements ModelProvider {
  readonly name = 'local-audio';
  readonly type = 'direct' as const;

  supportsModel(modelName: string): boolean {
    return /^(whisper\.cpp|faster-whisper|kokoro|piper):/.test(modelName);
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    throw new Error(`${options.model} is a local speech engine, not a chat model. Bind it to the Transcription or Speech lane.`);
  }

  async *stream(options: CompletionOptions): AsyncGenerator<StreamChunk> {
    throw new Error(`${options.model} is a local speech engine, not a chat model.`);
  }

  /** The engines are probed per row (speechRowAvailable); the provider itself is always there. */
  async checkHealth(): Promise<ProviderHealthStatus> {
    return { healthy: true };
  }
}
