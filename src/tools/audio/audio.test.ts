/**
 * audio__transcribe_audio and audio__speak (src/tools/audio): the lanes, in
 * the workspace, within the session's protection level; long recordings cut
 * into parts and stitched.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentContext } from '@/core/types';

const state = vi.hoisted(() => ({
  root: '',
  transcribe: vi.fn(async (_audio: Buffer, _req: Record<string, unknown>) => ({ text: 'hello world', segments: [{ start: 0, end: 2, text: 'hello world', confidence: 1 }], language: 'en', duration: 2, model: 'local whisper' })),
  synthesize: vi.fn(async () => ({ audio: Buffer.from('ID3fake'), format: 'mp3', contentType: 'audio/mpeg', model: 'local kokoro' })),
}));

vi.mock('@/security/workspace-fs', async (orig) => {
  const real = await orig<typeof import('@/security/workspace-fs')>();
  const TestFS = new Proxy(real.WorkspaceFS, {
    get: (target, prop, receiver) => (prop === 'forAgent' ? () => target.withRoot(state.root) : Reflect.get(target, prop, receiver)),
  });
  return { ...real, WorkspaceFS: TestFS };
});
vi.mock('@/voice/resolve', () => ({ transcribeWithLane: state.transcribe, synthesizeWithLane: state.synthesize }));
vi.mock('@/models/install-access', () => ({ mayUseInstallModels: async () => true }));

const mod = await import('./index');
const tool = new mod.AudioTool() as unknown as {
  transcribe(args: Record<string, unknown>, ctx: AgentContext): Promise<Record<string, unknown>>;
  speak(args: Record<string, unknown>, ctx: AgentContext): Promise<Record<string, unknown>>;
};
const ctx = { id: 'a1', sessionId: 's1', userId: 'u1', role: 'general' } as unknown as AgentContext;
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

beforeEach(async () => { state.root = await mkdtemp(join(tmpdir(), 'octipus-audio-')); vi.clearAllMocks(); });
afterEach(async () => { await rm(state.root, { recursive: true, force: true }); });

describe('transcribe_audio', () => {
  test('a recording in the workspace through the Transcription lane, with the session and its format', async () => {
    await writeFile(join(state.root, 'memo.m4a'), Buffer.from('fake'));
    const out = await tool.transcribe({ source: 'memo.m4a', language: 'de' }, ctx);
    expect(out).toMatchObject({ source: 'memo.m4a', text: 'hello world', language: 'en', model: 'local whisper' });
    expect(out.segments).toBeUndefined();
    expect(state.transcribe).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ sessionId: 's1', userId: 'u1', format: 'm4a', language: 'de', allowHosted: true }));
    expect((await tool.transcribe({ source: 'memo.m4a', timestamps: true }, ctx)).segments).toHaveLength(1);
  });

  test('outside the workspace or missing: refused before anything is read', async () => {
    await expect(tool.transcribe({ source: '../../etc/passwd' }, ctx)).rejects.toThrow(/outside allowed workspace/);
    await expect(tool.transcribe({ source: 'nope.mp3' }, ctx)).rejects.toThrow(/No recording/);
    expect(state.transcribe).not.toHaveBeenCalled();
    await writeFile(join(state.root, 'memo.mp3'), Buffer.from('fake'));
    await expect(tool.transcribe({ source: 'memo.mp3', language: 'en; rm -rf /' }, ctx)).rejects.toThrow(/not a language code/);
  });

  test.skipIf(!hasFfmpeg)('a video is converted to audio first, even when short', async () => {
    const video = join(state.root, 'clip.mp4');
    expect(spawnSync('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=d=2', '-c:a', 'aac', video]).status).toBe(0);
    const out = await tool.transcribe({ source: 'clip.mp4' }, ctx);
    expect(out).toMatchObject({ parts: 1 });
    expect(Number(out.durationSec)).toBeCloseTo(2, 0);
    expect(state.transcribe.mock.calls[0][1]).toMatchObject({ format: 'wav' });
  });

  test.skipIf(!hasFfmpeg)('a playlist dressed as a recording is not opened (it would read other files)', async () => {
    const pad = '#'.repeat(21 * 1024 * 1024);
    await writeFile(join(state.root, 'evil.m3u8'), `#EXTM3U\n${pad}\n#EXTINF:1,\n/etc/hosts\n#EXT-X-ENDLIST\n`);
    await expect(tool.transcribe({ source: 'evil.m3u8' }, ctx)).rejects.toThrow(/ffmpeg failed/);
    expect(state.transcribe).not.toHaveBeenCalled();
  });

  test.skipIf(!hasFfmpeg)('a long recording is cut into ten-minute parts; times are shifted and texts stitched', async () => {
    const big = join(state.root, 'meeting.wav');
    // 11 minutes of 16 kHz mono silence: over the single-request size, two parts.
    expect(spawnSync('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '660', '-c:a', 'pcm_s16le', big]).status).toBe(0);
    let n = 0;
    // The engines' `duration` is processing time, not the recording's: offsets come from the parts.
    state.transcribe.mockImplementation(async () => ({ text: `part ${++n}`, segments: [{ start: 1, end: 2, text: `p${n}`, confidence: 1 }], language: 'en', duration: 3, model: 'm' }));
    const out = await tool.transcribe({ source: 'meeting.wav', timestamps: true }, ctx);
    expect(out).toMatchObject({ text: 'part 1\npart 2', parts: 2 });
    expect(Number(out.durationSec)).toBeCloseTo(660, 0);
    const segments = out.segments as Array<{ start: number; end: number; text: string }>;
    expect(segments.map((s) => s.text)).toEqual(['p1', 'p2']);
    expect(segments[0].start).toBe(1);
    expect(segments[1].start).toBeCloseTo(601, 0);
    expect(state.transcribe.mock.calls.every(([, req]) => req.format === 'wav')).toBe(true);
  });
});

describe('speak', () => {
  test('speech through the Speech lane is saved in the workspace and its path returned', async () => {
    const out = await tool.speak({ text: 'Read me', voice: 'af_bella' }, ctx);
    expect(out).toMatchObject({ mimeType: 'audio/mpeg', model: 'local kokoro', characters: 7 });
    expect(String(out.path)).toMatch(/^\.octipus\/media\/speech\/[0-9a-f-]+\.mp3$/);
    expect(await readFile(join(state.root, String(out.path)), 'utf8')).toBe('ID3fake');
    expect(state.synthesize).toHaveBeenCalledWith('Read me', expect.objectContaining({ sessionId: 's1', userId: 'u1', voice: 'af_bella', format: 'mp3' }));
  });

  test('an output path inside the workspace is used; outside or an existing file is refused before anything is paid for', async () => {
    expect((await tool.speak({ text: 'hi', output_path: 'out/hello.mp3' }, ctx)).path).toBe('out/hello.mp3');
    state.synthesize.mockClear();
    await expect(tool.speak({ text: 'hi', output_path: '../x.mp3' }, ctx)).rejects.toThrow(/outside allowed workspace/);
    await writeFile(join(state.root, 'notes.md'), 'mine');
    await expect(tool.speak({ text: 'hi', output_path: 'notes.md' }, ctx)).rejects.toThrow(/already exists/);
    expect(await readFile(join(state.root, 'notes.md'), 'utf8')).toBe('mine');
    expect(state.synthesize).not.toHaveBeenCalled();
    await expect(tool.speak({ text: 'x'.repeat(mod.MAX_SPEAK_CHARS + 1) }, ctx)).rejects.toThrow(/at most/);
  });
});
