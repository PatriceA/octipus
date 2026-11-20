/**
 * Voice profiles (src/voice/profiles.ts): what a name and a clip may be, the
 * clip stored as WAV every speech server reads, the order a save changes
 * files in, and a clip that went missing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  failUpdate: false,
  ffmpeg: false,
}));

vi.mock('@/config/settings-service', () => ({
  getSettingsService: () => ({
    get: async (key: string) => state.values[key],
    set: async (key: string, value: unknown) => { state.values[key] = value; },
    update: async (key: string, fn: (current: unknown) => unknown) => {
      if (state.failUpdate) throw new Error('settings store unavailable');
      state.values[key] = fn(state.values[key]);
    },
  }),
}));
vi.mock('@/utils/proc', async (orig) => ({
  ...(await orig<typeof import('@/utils/proc')>()),
  whichSync: (bin: string) => (bin === 'ffmpeg' && state.ffmpeg ? '/usr/bin/ffmpeg' : null),
}));

const dir = mkdtempSync(join(tmpdir(), 'voices-'));
process.env.OCTIPUS_VOICES_DIR = dir;
afterAll(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.OCTIPUS_VOICES_DIR; });

const { getVoiceProfile, saveVoiceProfile, voiceProfileClip } = await import('./profiles');
const { parseWav, pcmToWav } = await import('./wav');

/** A WAV of `seconds` of a ramp at `rate`, `channels` interleaved. */
function wav(seconds: number, rate = 24000, channels = 1): Buffer {
  const frames = seconds * rate;
  const pcm = new Int16Array(frames * channels);
  for (let i = 0; i < pcm.length; i++) pcm[i] = (i % 2000) - 1000;
  const mono = pcmToWav(new Uint8Array(pcm.buffer), rate);
  if (channels === 1) return mono;
  mono.writeUInt16LE(channels, 22);
  mono.writeUInt32LE(rate * 2 * channels, 28);
  mono.writeUInt16LE(2 * channels, 32);
  return mono;
}

const files = () => readdirSync(dir).sort();
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

beforeEach(() => {
  state.values = {};
  state.failUpdate = false;
  state.ffmpeg = false;
  for (const f of readdirSync(dir)) rmSync(join(dir, f));
});

describe('what a profile may be', () => {
  test('a name is 1–60 letters, digits, spaces, dots, dashes or underscores', async () => {
    for (const bad of ['', ' ', '../voices', 'a/b', '-lead', 'x'.repeat(61)]) {
      await expect(saveVoiceProfile({ name: bad, voice: 'af_sarah' }), bad).rejects.toThrow(/1–60 letters/);
    }
    await expect(saveVoiceProfile({ name: 'Calm narrator 2.0', voice: 'af_sarah' })).resolves.toMatchObject({ name: 'Calm narrator 2.0' });
  });

  test('a clip is audio, not empty, at most 10 MB; a profile needs a voice, a description or a clip', async () => {
    await expect(saveVoiceProfile({ name: 'a', clip: { data: Buffer.from('x'), mimeType: 'text/plain' } })).rejects.toThrow(/must be an audio file/);
    await expect(saveVoiceProfile({ name: 'a', clip: { data: Buffer.alloc(0), mimeType: 'audio/wav' } })).rejects.toThrow(/at most 10 MB/);
    await expect(saveVoiceProfile({ name: 'a', clip: { data: Buffer.alloc(10 * 1024 * 1024 + 1), mimeType: 'audio/wav' } })).rejects.toThrow(/at most 10 MB/);
    await expect(saveVoiceProfile({ name: 'a', description: 'nothing else' })).rejects.toThrow(/needs a voice, a description or a reference clip/);
    expect(files()).toEqual([]);
  });

  test('a stored clip name that is not one this module made is refused', async () => {
    await expect(voiceProfileClip({ name: 'x', refAudio: '../../etc/passwd' })).rejects.toThrow(/invalid clip/);
  });
});

describe('the clip is stored as WAV', () => {
  test('without ffmpeg: a WAV is taken, made mono and cut to 20 seconds; anything else is refused, naming ffmpeg', async () => {
    const saved = await saveVoiceProfile({ name: 'clone', refText: 'hello', clip: { data: wav(25, 24000, 2), mimeType: 'audio/x-wav' } });
    expect(saved).toMatchObject({ refAudioType: 'audio/wav', refText: 'hello' });
    expect(saved.refAudio).toMatch(/\.wav$/);
    const stored = parseWav(readFileSync(join(dir, saved.refAudio!)));
    expect(stored.sampleRate).toBe(24000);
    expect(stored.pcm.length / 2 / stored.sampleRate).toBe(20);

    await expect(saveVoiceProfile({ name: 'webm', clip: { data: Buffer.from('\x1aE\xdf\xa3 webm bytes'), mimeType: 'audio/webm;codecs=opus' } }))
      .rejects.toThrow(/converted to WAV with ffmpeg, which is not installed.*audio\/webm/);
    expect(files()).toEqual([saved.refAudio]);
  });

  test.skipIf(!hasFfmpeg)('with ffmpeg: a browser recording becomes mono 16-bit WAV at 24 kHz, at most 20 seconds', async () => {
    state.ffmpeg = true;
    const work = mkdtempSync(join(tmpdir(), 'clip-src-'));
    try {
      const ogg = join(work, 'rec.ogg');
      expect(spawnSync('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=25:sample_rate=48000', '-ac', '2', '-c:a', 'libvorbis', ogg]).status).toBe(0);
      const saved = await saveVoiceProfile({ name: 'rec', refText: 'hi', clip: { data: readFileSync(ogg), mimeType: 'audio/ogg; codecs=opus' } });
      expect(saved.refAudioType).toBe('audio/wav');
      const bytes = readFileSync(join(dir, saved.refAudio!));
      expect(bytes.readUInt16LE(22)).toBe(1); // mono
      const stored = parseWav(bytes);
      expect(stored.sampleRate).toBe(24000);
      expect(stored.pcm.length / 2 / stored.sampleRate).toBeCloseTo(20, 1);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('saving changes files in a safe order', () => {
  test('a new clip replaces the old file only once the profile is saved', async () => {
    const first = await saveVoiceProfile({ name: 'v', refText: 'one', clip: { data: wav(1), mimeType: 'audio/wav' } });
    const second = await saveVoiceProfile({ name: 'v', refText: 'two', clip: { data: wav(2), mimeType: 'audio/wav' } });
    expect(files()).toEqual([second.refAudio]);
    expect(second.refAudio).not.toBe(first.refAudio);
  });

  test('a save that fails keeps the old clip and leaves no new file behind', async () => {
    const first = await saveVoiceProfile({ name: 'v', refText: 'one', clip: { data: wav(1), mimeType: 'audio/wav' } });
    state.failUpdate = true;
    await expect(saveVoiceProfile({ name: 'v', refText: 'two', clip: { data: wav(2), mimeType: 'audio/wav' } })).rejects.toThrow(/unavailable/);
    await expect(saveVoiceProfile({ name: 'v', voice: 'af_sarah', clip: null })).rejects.toThrow(/unavailable/);
    expect(files()).toEqual([first.refAudio]);
    expect((await getVoiceProfile('v'))?.refAudio).toBe(first.refAudio);
  });

  test('clip: null removes the clip and its words; leaving it out keeps them', async () => {
    const first = await saveVoiceProfile({ name: 'v', voice: 'S3', refText: 'one', clip: { data: wav(1), mimeType: 'audio/wav' } });
    await expect(saveVoiceProfile({ name: 'v', voice: 'S3', refText: 'one' })).resolves.toMatchObject({ refAudio: first.refAudio, refText: 'one' });
    const removed = await saveVoiceProfile({ name: 'v', voice: 'S3', refText: 'one', clip: null });
    expect(removed.refAudio).toBeUndefined();
    expect(removed.refText).toBeUndefined();
    expect(files()).toEqual([]);
  });
});

describe('reading a clip', () => {
  test('a clip that is gone from disk is no clip, not a failed reply', async () => {
    const saved = await saveVoiceProfile({ name: 'v', refText: 'one', clip: { data: wav(1), mimeType: 'audio/wav' } });
    rmSync(join(dir, saved.refAudio!));
    await expect(voiceProfileClip(saved)).resolves.toBeUndefined();
    await expect(voiceProfileClip(saved)).resolves.toBeUndefined();
  });

  test('read once per file version: the same bytes are handed over until the file changes', async () => {
    const saved = await saveVoiceProfile({ name: 'v', refText: 'one', clip: { data: wav(1), mimeType: 'audio/wav' } });
    const a = await voiceProfileClip(saved);
    const b = await voiceProfileClip(saved);
    expect(a?.data).toBe(b?.data);
    const path = join(dir, saved.refAudio!);
    writeFileSync(path, wav(2));
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    const c = await voiceProfileClip(saved);
    expect(c?.data).not.toBe(a?.data);
    expect(c?.data.length).toBeGreaterThan(a!.data.length);
    expect(existsSync(path)).toBe(true);
  });
});
