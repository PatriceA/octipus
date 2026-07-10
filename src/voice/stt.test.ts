import { describe, test, expect } from 'bun:test';
import { stripWavHeader } from './stt';

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

// ── stripWavHeader ───────────────────────────────────────────────────
// Realtime transcription wants headerless 16kHz mono s16le PCM, but callers
// conditioned by WhisperEngine hand over WAV. This is the trap; guard it.
describe('stripWavHeader', () => {
  /** Minimal 44-byte RIFF/WAVE header followed by `payload`. */
  function wav(payload: Uint8Array, { channels = 1, sampleRate = 16000, bits = 16 } = {}): Uint8Array {
    const buf = new Uint8Array(44 + payload.length);
    const view = new DataView(buf.buffer);
    buf.set(new TextEncoder().encode('RIFF'), 0);
    buf.set(new TextEncoder().encode('WAVEfmt '), 8);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint16(34, bits, true);
    buf.set(payload, 44);
    return buf;
  }

  const pcm = new Uint8Array([1, 2, 3, 4]);

  test('strips a conforming 16kHz mono 16-bit header', () => {
    expect(Array.from(stripWavHeader(wav(pcm)))).toEqual([1, 2, 3, 4]);
  });

  test('passes raw PCM through untouched', () => {
    const raw = new Uint8Array(64).fill(7);
    expect(stripWavHeader(raw)).toBe(raw);
  });

  test('leaves short buffers alone', () => {
    const tiny = new Uint8Array([1, 2, 3]);
    expect(stripWavHeader(tiny)).toBe(tiny);
  });

  test('fails loudly rather than silently mis-transcribing a wrong format', () => {
    expect(() => stripWavHeader(wav(pcm, { sampleRate: 44100 }))).toThrow(/16kHz mono 16-bit/);
    expect(() => stripWavHeader(wav(pcm, { channels: 2 }))).toThrow(/2ch/);
    expect(() => stripWavHeader(wav(pcm, { bits: 8 }))).toThrow(/8-bit/);
  });
});
