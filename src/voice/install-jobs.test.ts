/**
 * Installing a local speech engine in the background (src/voice/install-jobs.ts):
 * one job per engine and model, the outcome and the log kept on the job.
 */
import { describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  downloads: new Map<string, { resolve: () => void; reject: (err: Error) => void }>(),
  used: [] as Array<{ engine: string; size?: string }>,
}));

vi.mock('./provision', () => ({
  installFasterWhisper: (model: string, progress: (line: string) => void) => new Promise<void>((resolve, reject) => {
    progress(`Downloading ${model}`);
    state.downloads.set(model, { resolve, reject });
  }),
  installKokoro: async () => {},
}));
vi.mock('./whisper', () => ({ installWhisper: async () => {} }));
vi.mock('./speech-rows', async (orig) => ({
  ...(await orig<typeof import('./speech-rows')>()),
  useSpeechEngine: async (engine: string, _direction: string, opts: { size?: string }) => {
    state.used.push({ engine, size: opts.size });
    return { row: { name: `local ${engine} ${opts.size ?? ''}`.trim() }, bound: 'primary', lane: 'transcription' };
  },
}));

const { speechInstallJobs, startSpeechInstall } = await import('./install-jobs');

const settled = async (job: { stage: string }) => vi.waitFor(() => expect(job.stage).not.toBe('running'));

describe('speech install jobs', () => {
  test('two faster-whisper models download side by side; asking again for one that runs returns its job', async () => {
    const small = startSpeechInstall('fasterwhisper', { size: 'small' });
    const turbo = startSpeechInstall('fasterwhisper', { size: 'large-v3-turbo' });
    expect(turbo).not.toBe(small);
    expect(turbo).toMatchObject({ engine: 'fasterwhisper', size: 'large-v3-turbo', stage: 'running' });
    // No size is `small`: the same job.
    expect(startSpeechInstall('fasterwhisper')).toBe(small);
    expect(startSpeechInstall('fasterwhisper', { size: 'large-v3-turbo' })).toBe(turbo);

    await vi.waitFor(() => expect(state.downloads.has('large-v3-turbo')).toBe(true));
    state.downloads.get('large-v3-turbo')!.resolve();
    await settled(turbo);
    expect(turbo).toMatchObject({ stage: 'done', model: 'local fasterwhisper large-v3-turbo', bound: 'primary' });
    expect(small.stage).toBe('running');

    await vi.waitFor(() => expect(state.downloads.has('small')).toBe(true));
    state.downloads.get('small')!.reject(new Error('network down'));
    await settled(small);
    expect(small).toMatchObject({ stage: 'error', error: 'network down' });
    expect(small.log).toEqual(['Downloading small']);
    expect(state.used).toEqual([{ engine: 'fasterwhisper', size: 'large-v3-turbo' }]);

    // A finished job is started again on request; the list carries both models.
    const again = startSpeechInstall('fasterwhisper', { size: 'small' });
    expect(again).not.toBe(small);
    expect(speechInstallJobs().map((j) => j.size).sort()).toEqual(['large-v3-turbo', 'small']);
  });

  test('a model name that could be read as an option is refused before anything is downloaded', async () => {
    const job = startSpeechInstall('fasterwhisper', { size: '--extra-index-url=http://evil' });
    await settled(job);
    expect(job).toMatchObject({ stage: 'error', error: expect.stringMatching(/is not a faster-whisper model name/) });
    expect(state.downloads.has('--extra-index-url=http://evil')).toBe(false);
  });
});
