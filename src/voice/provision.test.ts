import { describe, expect, test } from 'vitest';
import { FASTER_WHISPER_MODELS, kokoroModelDir } from './provision';
import { catalogEntry } from './speech-rows';

describe('provision', () => {
  test('every faster-whisper model the setup offers becomes a model row; a name that could not be a model does not', () => {
    // The model is the row's id (`faster-whisper:<model>`), no longer a config
    // enum: any size, release name or Hugging Face repository is taken, and
    // the name is held to that shape because it becomes a process argument.
    for (const { id } of FASTER_WHISPER_MODELS) {
      expect(catalogEntry('fasterwhisper', 'stt', id)?.row.modelId).toBe(`faster-whisper:${id}`);
    }
    expect(catalogEntry('fasterwhisper', 'stt', 'deepdml/faster-whisper-large-v3-turbo-ct2')?.row).toMatchObject({
      modelId: 'faster-whisper:deepdml/faster-whisper-large-v3-turbo-ct2', name: 'local faster-whisper deepdml faster-whisper-large-v3-turbo-ct2',
    });
    for (const bad of ['--help', 'a b', '../../etc/passwd', 'x;rm -rf /', 'a/b/c']) {
      expect(() => catalogEntry('fasterwhisper', 'stt', bad)).toThrow(/not a faster-whisper model name/);
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
