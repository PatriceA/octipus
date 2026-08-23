import { describe, expect, test } from 'vitest';
import { computeSessionVerified } from './verification-evidence-repository';

describe('computeSessionVerified', () => {
  test('no evidence ⇒ not verified (fail loud, never assume a pass)', () => {
    expect(computeSessionVerified([])).toBe(false);
  });

  test('all checks passed ⇒ verified', () => {
    expect(computeSessionVerified([{ passed: true }, { passed: true }])).toBe(true);
  });

  test('any failing check ⇒ not verified', () => {
    expect(computeSessionVerified([{ passed: true }, { passed: false }, { passed: true }])).toBe(false);
  });

  test('a single passing check is enough', () => {
    expect(computeSessionVerified([{ passed: true }])).toBe(true);
  });
});
