import { describe, expect, test } from 'vitest';
import { COMPANION_STATES } from './companion';
import { companionFrames } from './companion-frames';
import {
  applyPresenceSnapshot, emptyPresence, momentTitle, nextPresenceChange, PRESENCE_BEAT_MS, PRESENCE_SLEEP_MS, PRESENCE_STALE_MS,
  presenceDetail, presenceLabel, presenceState, reducePresence,
} from './companion-presence';

const T0 = 1_000_000;

describe('companion presence across conversations', () => {
  test('a turn works, finishes with a moment, cheers briefly, then idles', () => {
    let state = emptyPresence(T0);
    ({ state } = reducePresence(state, { id: 'e1', type: 'rootAgent.status', sessionId: 's1', payload: { message: 'Thinking' } }, T0));
    expect(presenceState(state, T0, true)).toBe('working');
    const done = reducePresence(state, { id: 'e2', type: 'chat.response', sessionId: 's1', payload: { response: { response: '**Here** are three [directions](http://x).' } } }, T0 + 10);
    expect(done.moment).toEqual({ kind: 'done', eventId: 'e2', sessionId: 's1', detail: 'Here are three directions.' });
    expect(presenceState(done.state, T0 + 20, true)).toBe('done');
    expect(presenceState(done.state, T0 + 10 + PRESENCE_BEAT_MS, true)).toBe('idle');
  });

  test('requests win over work and resolve whichever channel answered', () => {
    let state = emptyPresence(T0);
    ({ state } = reducePresence(state, { id: 'e1', type: 'agent.spawned', sessionId: 's1' }, T0));
    const asked = reducePresence(state, { id: 'e2', type: 'permission.request', sessionId: 's2', payload: { requestId: 'r1', toolName: 'shell' } }, T0);
    expect(asked.moment).toMatchObject({ kind: 'needs_input', detail: 'Wants to use shell.' });
    expect(presenceState(asked.state, T0, true)).toBe('waiting');
    expect(presenceLabel('Sparkle', asked.state, T0, true)).toBe('Sparkle needs your input');
    // A duplicate request (another tab's replay) is not a second moment.
    expect(reducePresence(asked.state, { id: 'e3', type: 'permission.request', sessionId: 's2', payload: { requestId: 'r1' } }, T0).moment).toBeNull();
    ({ state } = reducePresence(asked.state, { id: 'e4', type: 'permission.resolved', payload: { requestId: 'r1' } }, T0));
    expect(presenceState(state, T0, true)).toBe('working');
  });

  test('approvals carry their question; snapshots resync silently', () => {
    const asked = reducePresence(emptyPresence(T0), { id: 'e1', type: 'agent.approval_required', sessionId: 's1', payload: { requestId: 'a1', question: 'Ship it?' } }, T0);
    expect(asked.moment?.detail).toBe('Ship it?');
    const synced = applyPresenceSnapshot(asked.state, { requests: [], approvals: [] });
    expect(presenceState(synced, T0, true)).toBe('idle');
    const restored = applyPresenceSnapshot(synced, { requests: [{ requestId: 'r9' }], approvals: [{ requestId: 'a9', sessionId: 's3' }] });
    expect(presenceLabel('Pip', restored, T0, true)).toBe('Pip needs your input (2 requests)');
  });

  test('failures slump, lost connections interrupt, silence dozes, stale turns drop', () => {
    const failed = reducePresence(emptyPresence(T0), { id: 'e1', type: 'chat.error', sessionId: 's1', payload: { error: 'Provider timed out' } }, T0);
    expect(failed.moment).toMatchObject({ kind: 'failed', detail: 'Provider timed out' });
    expect(presenceState(failed.state, T0, true)).toBe('interrupted');
    expect(presenceState(emptyPresence(T0), T0, false)).toBe('interrupted');
    expect(presenceState(emptyPresence(T0), T0 + PRESENCE_SLEEP_MS, true)).toBe('sleeping');
    const { state } = reducePresence(emptyPresence(T0), { id: 'e2', type: 'chat.delta', sessionId: 's1' }, T0);
    expect(presenceState(state, T0 + PRESENCE_STALE_MS, true)).toBe('idle');
    expect(presenceLabel('Pip', state, T0, true)).toBe('Pip is working');
  });

  test('the next scheduled change is the earliest pending transition', () => {
    const { state } = reducePresence(emptyPresence(T0), { id: 'e1', type: 'chat.response', sessionId: 's1', payload: {} }, T0);
    expect(nextPresenceChange(state, T0)).toBe(T0 + PRESENCE_BEAT_MS);
    expect(nextPresenceChange(state, T0 + PRESENCE_BEAT_MS)).toBe(T0 + PRESENCE_SLEEP_MS);
    expect(nextPresenceChange(state, T0 + PRESENCE_SLEEP_MS)).toBeNull();
  });

  test('details are one trimmed line and titles name the companion', () => {
    expect(presenceDetail('a\n\n```ts\ncode\n```\n# Title  b')).toBe('a Title b');
    expect(presenceDetail('x'.repeat(300))).toHaveLength(140);
    expect(momentTitle('Sparkle', 'needs_input')).toBe('Sparkle needs your input');
  });
});

describe('companion icon frames', () => {
  test.each(COMPANION_STATES)('%s draws at least one well-formed frame in the saved colour', (state) => {
    const { frames, intervalMs } = companionFrames({ form: 'ink', color: 'coral' }, state);
    expect(frames.length).toBeGreaterThan(0);
    expect(intervalMs).toBeGreaterThanOrEqual(80);
    for (const svg of frames) {
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(svg.endsWith('</svg>')).toBe(true);
      expect(svg).toContain('#efa99b');
      expect(svg).not.toMatch(/NaN|undefined/);
    }
  });

  test('a missing or invalid appearance falls back to the default sea-glass pebble', () => {
    expect(companionFrames(undefined, 'idle').frames[0]).toContain('#92c9c5');
    expect(companionFrames({ form: 'blob', color: 'x' } as never, 'idle').frames[0]).toContain('#92c9c5');
  });

  test('the done cheer plays once; work and waiting loop', () => {
    expect(companionFrames(undefined, 'done').loop).toBe(false);
    expect(companionFrames(undefined, 'working').loop).toBe(true);
    expect(companionFrames(undefined, 'waiting').frames.join('')).toContain('#f2b34a');
  });
});
