/**
 * CallManager: calls in memory, status changes announced, ended calls kept
 * for an hour (make_call's result, end_call, /api/voice/calls) and then gone.
 */
import { describe, expect, test } from 'vitest';
import { CallManager, type CallSession, ENDED_CALL_RETENTION_MS, STALE_CALL_MS } from './interface';

function session(id: string, at: number): CallSession {
  return {
    id, provider: 'twilio', providerCallId: `CA-${id}`, direction: 'outbound', from: '+1', to: '+2',
    status: 'initiated', startedAt: new Date(at), metadata: {},
  };
}

describe('CallManager', () => {
  test('an ended call is listed for an hour, then removed', () => {
    let now = 1_000_000;
    const calls = new CallManager(() => now);
    calls.create(session('a', now));
    calls.updateStatus('a', 'active');
    now += 60_000;
    calls.updateStatus('a', 'ended');
    expect(calls.get('a')?.endedAt?.getTime()).toBe(now);

    now += ENDED_CALL_RETENTION_MS - 1;
    expect(calls.list().map((c) => c.id)).toEqual(['a']);
    expect(calls.getByProviderCallId('CA-a')?.status).toBe('ended');

    now += 2;
    expect(calls.list()).toEqual([]);
    expect(calls.get('a')).toBeUndefined();
  });

  test('a call in progress is kept; one that never reported an end goes after a day', () => {
    let now = 0;
    const calls = new CallManager(() => now);
    calls.create(session('old', now));
    calls.updateStatus('old', 'active');
    now += ENDED_CALL_RETENTION_MS * 2;
    calls.create(session('new', now));
    expect(calls.list().map((c) => c.id)).toEqual(['old', 'new']);
    now = STALE_CALL_MS + 1;
    expect(calls.list().map((c) => c.id)).toEqual(['new']);
  });

  test('answeredAt and endedAt are set once; status is announced only when it changes', () => {
    let now = 10;
    const calls = new CallManager(() => now);
    const seen: string[] = [];
    calls.on('status', (c) => seen.push(c.status));
    calls.create(session('a', now));
    calls.updateStatus('a', 'answered');
    now = 20;
    calls.updateStatus('a', 'active');
    calls.updateStatus('a', 'active');
    calls.updateStatus('a', 'ended');
    now = 30;
    calls.updateStatus('a', 'failed');
    expect(seen).toEqual(['answered', 'active', 'ended', 'failed']);
    expect(calls.get('a')?.answeredAt?.getTime()).toBe(10);
    expect(calls.get('a')?.endedAt?.getTime()).toBe(20);
  });

  test('waitForEnd resolves on the status change that ends the call, without polling', async () => {
    const calls = new CallManager();
    calls.create(session('a', Date.now()));
    const waiting = calls.waitForEnd('a', 60_000);
    calls.updateStatus('a', 'ringing');
    calls.updateStatus('a', 'no-answer');
    expect(await waiting).toBe('no-answer');
    expect(calls.listenerCount('status')).toBe(0);
    // Already over, or unknown: at once.
    expect(await calls.waitForEnd('a', 60_000)).toBe('no-answer');
    expect(await calls.waitForEnd('nope', 60_000)).toBeUndefined();
  });

  test('waitForEnd gives the status the call has when the time runs out', async () => {
    const calls = new CallManager();
    calls.create(session('a', Date.now()));
    calls.updateStatus('a', 'active');
    expect(await calls.waitForEnd('a', 5)).toBe('active');
    expect(calls.listenerCount('status')).toBe(0);
  });
});
