import { describe, expect, test } from 'vitest';
import { Endpointer, type EndpointEvent, pcmRms } from './endpointer';

/** `ms` of a 220 Hz tone at `level` (0–1 peak), or silence at level 0, as 16 kHz s16le. */
function audio(ms: number, level: number): Uint8Array {
  const n = Math.round((ms / 1000) * 16000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / 16000) * level * 32767);
  return new Uint8Array(out.buffer);
}
const types = (events: EndpointEvent[]) => events.map((e) => e.type);
const feed = (ep: Endpointer, ...parts: Uint8Array[]) => parts.flatMap((p) => ep.push(p));

describe('Endpointer', () => {
  test('a turn starts with speech and ends after the pause; the utterance keeps a lead-in and a short tail', () => {
    const ep = new Endpointer({ silenceMs: 600 });
    expect(feed(ep, audio(500, 0))).toEqual([]);
    expect(types(feed(ep, audio(1000, 0.3)))).toEqual(['speech_start']);
    expect(ep.active).toBe(true);
    expect(feed(ep, audio(400, 0))).toEqual([]); // a thinking pause, not the end
    expect(feed(ep, audio(500, 0.3))).toEqual([]);
    const end = feed(ep, audio(700, 0));
    expect(types(end)).toEqual(['speech_end']);
    const ended = end[0] as Extract<EndpointEvent, { type: 'speech_end' }>;
    // 300 ms lead-in + 1000 + 400 + 500 of talking and pause + 200 ms tail.
    expect(ended.ms).toBeGreaterThanOrEqual(2300);
    expect(ended.ms).toBeLessThanOrEqual(2500);
    expect(ended.pcm.length).toBe((ended.ms / 1000) * 32000);
    expect(ep.active).toBe(false);
  });

  test('audio arriving in odd-sized pieces gives the same turns', () => {
    const whole = new Uint8Array([...audio(300, 0), ...audio(800, 0.3), ...audio(900, 0)]);
    const one = types(new Endpointer().push(whole));
    const ep = new Endpointer();
    const pieces: EndpointEvent[] = [];
    for (let i = 0; i < whole.length; i += 333) pieces.push(...ep.push(whole.subarray(i, i + 333)));
    expect(types(pieces)).toEqual(one);
    expect(one).toEqual(['speech_start', 'speech_end']);
  });

  test('a click is not a turn', () => {
    const ep = new Endpointer({ minSpeechMs: 200 });
    expect(types(feed(ep, audio(300, 0), audio(80, 0.5), audio(1000, 0)))).toEqual(['speech_start']);
    expect(ep.active).toBe(false);
  });

  test('the level that counts as speech follows the room: steady background noise is not speech', () => {
    const ep = new Endpointer();
    // A noisy room (well above the default floor) heard first, quietly rising: learned as background.
    const events = feed(ep, audio(200, 0.005), audio(3000, 0.02));
    expect(types(events).filter((t) => t === 'speech_end')).toEqual([]);
    ep.reset();
    expect(types(feed(ep, audio(600, 0.4)))).toEqual(['speech_start']);
  });

  test('while a reply is spoken only clear, sustained over-talk interrupts it', () => {
    const ep = new Endpointer({ bargeRms: 0.04, bargeMs: 300 });
    ep.setSpeaking(true);
    // The reply's own echo: audible, short of the barge-in level.
    expect(feed(ep, audio(1500, 0.04))).toEqual([]);
    // A short loud burst is not enough.
    expect(feed(ep, audio(200, 0.4), audio(200, 0))).toEqual([]);
    expect(types(feed(ep, audio(600, 0.4)))).toEqual(['barge_in', 'speech_start']);
    // What was said while interrupting is part of the turn.
    const end = feed(ep, audio(800, 0))[0] as Extract<EndpointEvent, { type: 'speech_end' }>;
    expect(end.type).toBe('speech_end');
    expect(end.ms).toBeGreaterThanOrEqual(800);
  });

  test('over-talk is recognised through the gaps between syllables', () => {
    const ep = new Endpointer({ bargeRms: 0.04, bargeMs: 300 });
    ep.setSpeaking(true);
    // Speech as it is: bursts of sound with short dips, never 300 ms unbroken.
    const syllables = Array.from({ length: 6 }, () => [audio(120, 0.4), audio(40, 0.005)]).flat();
    expect(types(feed(ep, ...syllables))).toEqual(['barge_in', 'speech_start']);
  });

  test('with barge-in off the microphone is ignored while a reply is spoken', () => {
    const ep = new Endpointer({ bargeIn: false });
    ep.setSpeaking(true);
    expect(feed(ep, audio(2000, 0.5))).toEqual([]);
    ep.setSpeaking(false);
    expect(types(feed(ep, audio(300, 0), audio(500, 0.5)))).toEqual(['speech_start']);
  });

  test('a turn with no pause is cut at the length limit', () => {
    const ep = new Endpointer({ maxUtteranceMs: 2000 });
    const events = feed(ep, audio(3000, 0.3));
    expect(types(events)).toContain('speech_end');
  });

  test('rms of silence is 0 and of a full-scale tone about 0.7', () => {
    expect(pcmRms(audio(100, 0))).toBe(0);
    expect(pcmRms(audio(100, 1))).toBeCloseTo(0.707, 1);
  });
});
