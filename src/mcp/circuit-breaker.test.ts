import { beforeEach, describe, expect, test } from 'vitest';
import { McpCircuitBreaker } from './circuit-breaker';

describe('McpCircuitBreaker', () => {
  let cb: McpCircuitBreaker;

  beforeEach(() => {
    cb = new McpCircuitBreaker({ failureThreshold: 3, initialCooldownMs: 100, maxCooldownMs: 500 });
  });

  test('starts closed, allows calls', () => {
    expect(cb.canCall('s1')).toBe(true);
    expect(cb.getState('s1').state).toBe('closed');
  });

  test('opens after 3 consecutive failures', () => {
    cb.recordFailure('s1');
    cb.recordFailure('s1');
    expect(cb.getState('s1').state).toBe('closed');
    cb.recordFailure('s1');
    expect(cb.getState('s1').state).toBe('open');
    expect(cb.canCall('s1')).toBe(false);
  });

  test('success resets counter', () => {
    cb.recordFailure('s1');
    cb.recordFailure('s1');
    cb.recordSuccess('s1');
    cb.recordFailure('s1');
    cb.recordFailure('s1');
    expect(cb.getState('s1').state).toBe('closed');
  });

  test('transitions to half_open after cooldown', async () => {
    cb.recordFailure('s1');
    cb.recordFailure('s1');
    cb.recordFailure('s1');
    expect(cb.canCall('s1')).toBe(false);
    await new Promise(r => setTimeout(r, 120));
    expect(cb.canCall('s1')).toBe(true);
    expect(cb.getState('s1').state).toBe('half_open');
  });

  test('probe success closes breaker', async () => {
    cb.recordFailure('s1');
    cb.recordFailure('s1');
    cb.recordFailure('s1');
    await new Promise(r => setTimeout(r, 120));
    cb.canCall('s1'); // trigger half_open transition
    cb.recordSuccess('s1');
    expect(cb.getState('s1').state).toBe('closed');
  });

  test('probe failure extends cooldown exponentially', async () => {
    cb.recordFailure('s1'); cb.recordFailure('s1'); cb.recordFailure('s1');
    await new Promise(r => setTimeout(r, 120));
    cb.canCall('s1'); // half_open
    cb.recordFailure('s1'); // probe failed
    expect(cb.getState('s1').state).toBe('open');
    expect(cb.getState('s1').cooldownRemainingMs).toBeGreaterThan(100);
  });

  test('cooldown caps at maxCooldownMs', async () => {
    cb.recordFailure('s1'); cb.recordFailure('s1'); cb.recordFailure('s1');
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 10));
      cb.recordFailure('s1');
    }
    const st = cb.getState('s1');
    expect(st.cooldownRemainingMs).toBeLessThanOrEqual(500);
  });

  test('reset clears all state', () => {
    cb.recordFailure('s1'); cb.recordFailure('s1'); cb.recordFailure('s1');
    cb.reset('s1');
    expect(cb.getState('s1').state).toBe('closed');
    expect(cb.getState('s1').failureCount).toBe(0);
  });

  test('per-server isolation', () => {
    cb.recordFailure('s1'); cb.recordFailure('s1'); cb.recordFailure('s1');
    expect(cb.getState('s1').state).toBe('open');
    expect(cb.getState('s2').state).toBe('closed');
    expect(cb.canCall('s2')).toBe(true);
  });

  test('listeners fire on state change', () => {
    const events: string[] = [];
    cb.onStateChange(e => events.push(e.state));
    cb.recordFailure('s1'); cb.recordFailure('s1'); cb.recordFailure('s1');
    expect(events).toContain('open');
    cb.reset('s1');
    expect(events).toContain('closed');
  });
});
