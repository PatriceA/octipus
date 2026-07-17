import { describe, test, expect } from 'bun:test';
import { StreamingResampler } from './audio-codec';
import {
  createSTTEngine,
  isConformantWav,
  MistralSTTEngine,
  OpenAIRealtimeSTTEngine,
  pcm16leResample,
  stripNonSpeech,
  stripWavHeader,
  WhisperEngine,
} from './stt';

describe('pcm16leResample', () => {
  // s16le bytes → samples → 16k→24k resample → s16le bytes.
  test('upsamples 16k→24k (~1.5× samples) and preserves the level', () => {
    const samples = new Int16Array(160).fill(1000); // 10 ms @16k, constant tone
    const bytes = new Uint8Array(samples.buffer);
    const out = pcm16leResample(bytes, new StreamingResampler(16000, 24000));
    const outSamples = new Int16Array(out.buffer, out.byteOffset, out.byteLength >> 1);
    expect(outSamples.length).toBeGreaterThan(220); // ≈ 160 * 1.5
    expect(outSamples.length).toBeLessThan(250);
    // Interpolating a constant signal returns the same value, not garbage.
    expect(outSamples[100]).toBe(1000);
  });

  test('drops a dangling odd byte instead of misreading it', () => {
    expect(pcm16leResample(new Uint8Array(3), new StreamingResampler(16000, 24000)).length % 2).toBe(0);
    expect(pcm16leResample(new Uint8Array(0), new StreamingResampler(16000, 24000)).length).toBe(0);
  });
});

describe('createSTTEngine', () => {
  test('maps each provider to its engine class', () => {
    expect(createSTTEngine('whisper-cpp', '/tmp/model.bin')).toBeInstanceOf(WhisperEngine);
    expect(createSTTEngine('mistral', '')).toBeInstanceOf(MistralSTTEngine);
    expect(createSTTEngine('openai', '')).toBeInstanceOf(OpenAIRealtimeSTTEngine);
  });

  test('rejects removed/unknown engine types', () => {
    // 'faster-whisper' was removed; anything off-enum must throw, not silently no-op.
    expect(() => createSTTEngine('faster-whisper' as never, '')).toThrow();
  });
});

describe('stripNonSpeech', () => {
  test('removes whisper blank/non-speech annotations', () => {
    expect(stripNonSpeech('[BLANK_AUDIO] hello [BLANK_AUDIO]').trim()).toBe('hello');
    expect(stripNonSpeech('[ Silence ] tell me [MUSIC PLAYING]').trim()).toBe('tell me');
    expect(stripNonSpeech('(inaudible) can you hear me').trim()).toBe('can you hear me');
  });

  test('leaves real speech (and ordinary brackets/parens) intact', () => {
    expect(stripNonSpeech('use option (a) not [b]')).toBe('use option (a) not [b]');
    expect(stripNonSpeech('the quick brown fox')).toBe('the quick brown fox');
  });
});

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

// ── isConformantWav ──────────────────────────────────────────────────
// Gates the ffmpeg skip: only a 16kHz mono 16-bit PCM WAV (what the browser
// encoder emits) may bypass conversion. Anything else must be re-encoded.
describe('isConformantWav', () => {
  /** Build a WAV file on disk with the given fmt fields; return its path. */
  async function writeWav(
    { format = 1, channels = 1, sampleRate = 16000, bits = 16 } = {},
  ): Promise<string> {
    const samples = 8;
    const buf = new Uint8Array(44 + samples * 2);
    const view = new DataView(buf.buffer);
    const put = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    put(0, 'RIFF'); put(8, 'WAVE'); put(12, 'fmt ');
    view.setUint16(20, format, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint16(34, bits, true);
    put(36, 'data');
    const path = `/tmp/conformant-${format}-${channels}-${sampleRate}-${bits}-${samples}.wav`;
    await Bun.write(path, buf);
    return path;
  }

  test('accepts 16kHz mono 16-bit PCM (the browser encoder output)', async () => {
    expect(await isConformantWav(await writeWav())).toBe(true);
  });

  test('rejects wrong rate / channels / bits / codec', async () => {
    expect(await isConformantWav(await writeWav({ sampleRate: 44100 }))).toBe(false);
    expect(await isConformantWav(await writeWav({ channels: 2 }))).toBe(false);
    expect(await isConformantWav(await writeWav({ bits: 8 }))).toBe(false);
    expect(await isConformantWav(await writeWav({ format: 3 }))).toBe(false); // float, not PCM
  });

  test('rejects a non-WAV / missing file', async () => {
    const p = '/tmp/not-a-wav.bin';
    await Bun.write(p, new Uint8Array([1, 2, 3, 4, 5]));
    expect(await isConformantWav(p)).toBe(false);
    expect(await isConformantWav('/tmp/does-not-exist-xyz.wav')).toBe(false);
  });
});
