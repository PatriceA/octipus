import { describe, test, expect } from 'bun:test';
import { FASTER_WHISPER_MODELS, kokoroModelDir } from './provision';
import { voiceConfigSchema } from '../config/schema';

describe('provision', () => {
  test('every faster-whisper wizard model is accepted by the config schema', () => {
    // The field is z.enum(...).default('small').catch('small'): an unknown value
    // is silently coerced to 'small'. So parsing each offered id must round-trip
    // to itself — if the wizard ever offers a model the enum drops, setup would
    // write a value that gets coerced away, and this catches it.
    for (const { id } of FASTER_WHISPER_MODELS) {
      const parsed = voiceConfigSchema.parse({ fasterWhisperModel: id }).fasterWhisperModel;
      expect(parsed).toBe(id);
    }
  });

  test('kokoro model dir is honoured from env', () => {
    const prev = process.env.KOKORO_MODEL_DIR;
    process.env.KOKORO_MODEL_DIR = '/tmp/kokoro-test-dir';
    expect(kokoroModelDir()).toBe('/tmp/kokoro-test-dir');
    if (prev === undefined) delete process.env.KOKORO_MODEL_DIR;
    else process.env.KOKORO_MODEL_DIR = prev;
  });
});
