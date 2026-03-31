import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { StallDetector } from './feedback';

describe('StallDetector', () => {
  let detector: StallDetector;
  const stalls: Array<{ agentId: string; level: string }> = [];

  beforeEach(() => {
    stalls.length = 0;
    detector = new StallDetector({
      onStall: (agentId, level) => stalls.push({ agentId, level }),
    });
  });

  afterEach(() => {
    detector.destroy();
  });

  test('no stall when agent is active', () => {
    detector.recordProgress('agent1');
    expect(detector.getStallLevel('agent1')).toBeNull();
  });

  test('returns null for unknown agent', () => {
    expect(detector.getStallLevel('unknown')).toBeNull();
  });

  test('detects soft stall after 10s', () => {
    // Manually set progress timestamp to 15s ago
    (detector as any).lastProgress.set('agent1', Date.now() - 15_000);
    expect(detector.getStallLevel('agent1')).toBe('soft');
  });

  test('detects hard stall after 30s', () => {
    (detector as any).lastProgress.set('agent1', Date.now() - 35_000);
    expect(detector.getStallLevel('agent1')).toBe('hard');
  });

  test('progress resets stall', () => {
    (detector as any).lastProgress.set('agent1', Date.now() - 35_000);
    expect(detector.getStallLevel('agent1')).toBe('hard');

    detector.recordProgress('agent1');
    expect(detector.getStallLevel('agent1')).toBeNull();
  });

  test('clear removes agent from tracking', () => {
    detector.recordProgress('agent1');
    detector.clear('agent1');
    expect(detector.getStallLevel('agent1')).toBeNull();
  });

  test('constants are correct', () => {
    expect(StallDetector.SOFT_THRESHOLD_MS).toBe(10_000);
    expect(StallDetector.HARD_THRESHOLD_MS).toBe(30_000);
    expect(StallDetector.CHECK_INTERVAL_MS).toBe(5_000);
  });
});
