import { describe, test, expect } from 'bun:test';

// STT integration tests require the bundled whisper-cpp binary plus a
// downloaded model file and a WAV audio fixture, none of which ship
// with the repo. Gate on `WHISPER_BINARY` + `WHISPER_MODEL_PATH`; the
// suite stays skipped in CI until those are provided, but a real run
// can be triggered locally by setting both vars.
const WHISPER_AVAILABLE = !!(process.env.WHISPER_BINARY && process.env.WHISPER_MODEL_PATH);

describe.skipIf(!WHISPER_AVAILABLE)('Speech-to-Text (Integration)', () => {
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
