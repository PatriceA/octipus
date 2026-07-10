import { describe, expect, test } from 'bun:test';
import { VoiceService } from './index';

// The mic-capture path (arecord) and transcription need real hardware + the
// whisper binary, so those are verified manually (roadmap Phase 3). These tests
// cover the environment-independent guards + state so a refactor can't silently
// break them.
describe('VoiceService push-to-talk guards', () => {
  test('startRecording without STT configured throws', () => {
    const v = new VoiceService();
    expect(() => v.startRecording()).toThrow(/speech-to-text not configured/i);
    expect(v.recording).toBe(false);
  });

  test('say() is a no-op (resolves) when TTS is not configured', async () => {
    const v = new VoiceService();
    await expect(v.say('hello')).resolves.toBeUndefined();
  });

  test('recording getter starts false', () => {
    expect(new VoiceService().recording).toBe(false);
  });
});
