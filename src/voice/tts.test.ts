import { describe, expect, test } from 'vitest';
import { createTTSEngine, KokoroEngine, MistralTTSEngine, OpenAITTSEngine, PiperEngine } from './tts';

describe('createTTSEngine', () => {
  test('maps each provider to its engine class', () => {
    expect(createTTSEngine('mistral')).toBeInstanceOf(MistralTTSEngine);
    expect(createTTSEngine('openai')).toBeInstanceOf(OpenAITTSEngine);
    expect(createTTSEngine('piper')).toBeInstanceOf(PiperEngine);
    expect(createTTSEngine('kokoro')).toBeInstanceOf(KokoroEngine);
  });

  test('rejects removed/unknown engine types', () => {
    // 'edge' and 'coqui' were removed; anything off-enum must throw.
    expect(() => createTTSEngine('edge' as never)).toThrow();
    expect(() => createTTSEngine('coqui' as never)).toThrow();
  });
});
