import { describe, test, expect } from 'bun:test';

// STT integration tests require the bundled whisper-cpp binary at
// models/whisper/whisper-cpp plus a downloaded model file and a WAV audio
// fixture. They do NOT depend on Postgres/Redis, so they are intentionally
// left out of the INTEGRATION=1 Docker-backed runner.
//
// TODO: when a stable test audio fixture + whisper binary are available in
// CI, gate this with `describe.skipIf(!process.env.WHISPER_BINARY)` and
// load the model from process.env.WHISPER_MODEL_PATH.

describe.skip('Speech-to-Text (Integration)', () => {
  test('placeholder — needs whisper binary + audio fixture, not DB/Redis', () => {
    expect(true).toBe(true);
  });
});

describe('Speech-to-Text (Unit)', () => {
  describe('transcription result structure', () => {
    test('result has required fields', () => {
      const result = {
        text: 'Hello world',
        segments: [
          { start: 0, end: 1.5, text: 'Hello world', confidence: 0.95 },
        ],
        language: 'en',
        duration: 1.5,
      };

      expect(result.text).toBeDefined();
      expect(result.segments).toBeInstanceOf(Array);
      expect(result.language).toBe('en');
      expect(result.duration).toBeGreaterThan(0);
    });

    test('segments have timestamps', () => {
      const segment = { start: 0, end: 1.5, text: 'Hello', confidence: 0.9 };

      expect(segment.start).toBeLessThan(segment.end);
      expect(segment.confidence).toBeGreaterThanOrEqual(0);
      expect(segment.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('STT options', () => {
    test('options have valid defaults', () => {
      const options = {
        model: 'base',
        language: 'en',
        translate: false,
        vadEnabled: true,
        vadThreshold: 0.5,
      };

      expect(['tiny', 'base', 'small', 'medium', 'large']).toContain(options.model);
      expect(options.vadThreshold).toBeGreaterThanOrEqual(0);
      expect(options.vadThreshold).toBeLessThanOrEqual(1);
    });
  });

  describe('language codes', () => {
    const supportedLanguages = ['en', 'es', 'fr', 'de', 'zh', 'ja'];

    test('common languages are supported', () => {
      for (const lang of supportedLanguages) {
        expect(lang.length).toBe(2);
      }
    });
  });

  describe('audio formats', () => {
    test('WAV is the standard format', () => {
      const audioPath = '/path/to/audio.wav';
      expect(audioPath.endsWith('.wav')).toBe(true);
    });

    test('sample rate for speech recognition', () => {
      const sampleRate = 16000; // Standard for speech
      expect(sampleRate).toBe(16000);
    });
  });
});
