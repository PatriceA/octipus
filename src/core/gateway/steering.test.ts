/**
 * Mid-run steering routing — trySteerRunningRootAgent. Uses spyOn (not
 * mock.module, which is process-wide and leaks) on the agent-manager singleton
 * and the repos. guardInput is left real so the security-hole regression is
 * covered against the actual patterns.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getAgentManager } from '@/core/agent-manager';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { trySteerRunningRootAgent } from './message-handler';

type FakeOpts = {
  role: string;
  /** The turn's root agent — what steering keys on since Phase 9. */
  root?: boolean;
  steerable?: boolean;
  onSteer?: (m: unknown) => void;
  /** Successive getStatus() returns; last value repeats. Defaults to 'running'. */
  statusSeq?: string[];
};

function fakeWorker(opts: FakeOpts): unknown {
  let i = 0;
  const seq = opts.statusSeq ?? ['running'];
  const w: Record<string, unknown> = {
    getContext: () => ({ role: opts.role, root: opts.root === true, sessionId: 's', id: 'a' }),
    getStatus: () => seq[Math.min(i++, seq.length - 1)],
  };
  if (opts.steerable !== false) w.steer = (m: unknown) => opts.onSteer?.(m);
  return w;
}

describe('trySteerRunningRootAgent', () => {
  const sid = '00000000-0000-0000-0000-000000000000';
  const mgr = getAgentManager();
  const getBySessionSpy = vi.spyOn(mgr, 'getBySession');
  const createSpy = vi.spyOn(messageRepository, 'create');
  const incSpy = vi.spyOn(sessionRepository, 'incrementMessageCount');

  beforeEach(() => {
    getBySessionSpy.mockReset();
    createSpy.mockReset();
    incSpy.mockReset();
    createSpy.mockResolvedValue(undefined as never);
    incSpy.mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    getBySessionSpy.mockReset();
    createSpy.mockReset();
    incSpy.mockReset();
  });

  test('no running rootAgent → false, no persist', async () => {
    getBySessionSpy.mockReturnValue([] as never);
    expect(await trySteerRunningRootAgent(sid, 'focus on auth')).toBe(false);
    expect(createSpy).not.toHaveBeenCalled();
    expect(incSpy).not.toHaveBeenCalled();
  });

  test('running rootAgent → steers, persists, increments, returns true', async () => {
    const steered: { role?: string; content?: string } = {};
    const w = fakeWorker({ role: 'general', root: true, onSteer: (m) => { Object.assign(steered, m); } });
    getBySessionSpy.mockReturnValue([w] as never);

    const r = await trySteerRunningRootAgent(sid, 'focus on the auth module');
    expect(r).toBe(true);
    expect(steered.role).toBe('user');
    expect(steered.content).toBe('focus on the auth module');
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(incSpy).toHaveBeenCalledTimes(1);
  });

  test('a spawned child is NOT steered — only the turn\'s root', async () => {
    const w = fakeWorker({ role: 'coding' });
    getBySessionSpy.mockReturnValue([w] as never);
    expect(await trySteerRunningRootAgent(sid, 'hi')).toBe(false);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('CLI worker without steer() is skipped', async () => {
    const w = fakeWorker({ role: 'general', root: true, steerable: false });
    getBySessionSpy.mockReturnValue([w] as never);
    expect(await trySteerRunningRootAgent(sid, 'hi')).toBe(false);
  });

  test('blocked input is not a hole around the guard → false, not steered, not persisted', async () => {
    let steered = false;
    const w = fakeWorker({ role: 'general', root: true, onSteer: () => { steered = true; } });
    getBySessionSpy.mockReturnValue([w] as never);
    // 'rm -rf /' trips the command-injection block pattern in input-guard.
    const r = await trySteerRunningRootAgent(sid, 'rm -rf /');
    expect(r).toBe(false);
    expect(steered).toBe(false);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('rootAgent finishes between status-check and steer → false, no orphaned persist', async () => {
    // getStatus: 'running' at filter time, 'completed' at the post-steer recheck.
    let steered = false;
    const w = fakeWorker({ role: 'general', root: true, statusSeq: ['running', 'completed'], onSteer: () => { steered = true; } });
    getBySessionSpy.mockReturnValue([w] as never);

    const r = await trySteerRunningRootAgent(sid, 'change course');
    expect(r).toBe(false);
    // steer() was attempted (dead-queue copy is harmless) but we must NOT persist.
    expect(steered).toBe(true);
    expect(createSpy).not.toHaveBeenCalled();
    expect(incSpy).not.toHaveBeenCalled();
  });

  test('picks the rootAgent among multiple session workers', async () => {
    let steeredRole = '';
    const child = fakeWorker({ role: 'coding' });
    const orch = fakeWorker({ role: 'general', root: true, onSteer: () => { steeredRole = 'root'; } });
    getBySessionSpy.mockReturnValue([child, orch] as never);
    expect(await trySteerRunningRootAgent(sid, 'hi')).toBe(true);
    expect(steeredRole).toBe('root');
  });
});
