import { describe, test, expect, beforeEach } from 'bun:test';
import { computeFingerprint, observe } from './pattern-detector';
import { SkillCache, setCacheForTesting } from './cache';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

describe('computeFingerprint', () => {
  test('deterministic', () => {
    const a = computeFingerprint({ topic: 'coding', toolSequence: ['bash', 'read'], briefShape: 'x' });
    const b = computeFingerprint({ topic: 'coding', toolSequence: ['bash', 'read'], briefShape: 'x' });
    expect(a).toBe(b);
  });

  test('tool order does not matter', () => {
    const a = computeFingerprint({ topic: 'c', toolSequence: ['a', 'b'] });
    const b = computeFingerprint({ topic: 'c', toolSequence: ['b', 'a'] });
    expect(a).toBe(b);
  });

  test('different topic → different fingerprint', () => {
    const a = computeFingerprint({ topic: 'coding', toolSequence: ['x'] });
    const b = computeFingerprint({ topic: 'research', toolSequence: ['x'] });
    expect(a).not.toBe(b);
  });

  test('missing topic handled', () => {
    expect(computeFingerprint({ toolSequence: ['x'] })).toMatch(/^[a-f0-9]{24}$/);
  });
});

describe('observe', () => {
  beforeEach(() => {
    const root = mkdtempSync(resolve(tmpdir(), 'skill-cache-'));
    setCacheForTesting(new SkillCache(root));
    delete process.env.SKILL_AUTO_EXTENSION;
  });

  const baseObs = (idx: number) => ({
    userId: 'u1',
    topic: 'coding',
    toolSequence: ['bash', 'read'],
    briefShape: 'install',
    sessionId: `s${idx}`,
    timestamp: new Date('2026-04-01T00:00:00Z'),
  });

  test('first two observations do not trigger', async () => {
    expect(await observe(baseObs(1))).toBeNull();
    expect(await observe(baseObs(2))).toBeNull();
  });

  test('third observation triggers', async () => {
    await observe(baseObs(1));
    await observe(baseObs(2));
    const trig = await observe(baseObs(3));
    expect(trig).not.toBeNull();
    expect(trig!.count).toBe(3);
    expect(trig!.exemplarSessionIds).toEqual(['s1', 's2', 's3']);
  });

  test('fourth observation does not re-trigger', async () => {
    for (let i = 1; i <= 3; i++) await observe(baseObs(i));
    const fourth = await observe(baseObs(4));
    expect(fourth).toBeNull();
  });

  test('disabled via env returns null', async () => {
    process.env.SKILL_AUTO_EXTENSION = 'false';
    for (let i = 1; i <= 5; i++) {
      expect(await observe(baseObs(i))).toBeNull();
    }
  });

  test('different users count separately', async () => {
    await observe({ ...baseObs(1), userId: 'u1' });
    await observe({ ...baseObs(2), userId: 'u2' });
    await observe({ ...baseObs(3), userId: 'u1' });
    expect(await observe({ ...baseObs(4), userId: 'u1' })).not.toBeNull();
  });
});
