import { describe, expect, test } from 'vitest';
import type { InstallJob } from './install';
import { emitInstallProgress, onInstallProgress } from './install-events';

const job = (over: Partial<InstallJob> = {}): InstallJob => ({
  id: 'j1',
  ownerId: 'u1',
  modelId: 'm',
  bindTopics: ['chat'],
  status: 'pulling',
  percent: 0,
  statusText: 'starting',
  startedAt: 0,
  ...over,
});

describe('install-events', () => {
  test('delivers emitted jobs to subscribers', () => {
    const seen: InstallJob[] = [];
    const off = onInstallProgress((j) => seen.push(j));
    emitInstallProgress(job({ percent: 50 }));
    off();
    expect(seen).toHaveLength(1);
    expect(seen[0].percent).toBe(50);
  });

  test('unsubscribe stops delivery', () => {
    const seen: InstallJob[] = [];
    const off = onInstallProgress((j) => seen.push(j));
    off();
    emitInstallProgress(job());
    expect(seen).toHaveLength(0);
  });

  test('a throwing listener does not break other listeners', () => {
    const seen: number[] = [];
    const off1 = onInstallProgress(() => { throw new Error('bad listener'); });
    const off2 = onInstallProgress((j) => seen.push(j.percent));
    expect(() => emitInstallProgress(job({ percent: 7 }))).not.toThrow();
    off1();
    off2();
    expect(seen).toEqual([7]);
  });
});
