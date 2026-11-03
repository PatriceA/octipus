import { describe, expect, test } from 'vitest';
import {
  FAILURE_STREAK_NUDGE_AT,
  FAILURE_STREAK_STOP_AT,
  FailureStreakDetector,
  failureStreakNudge,
  failureStreakStop,
} from './failure-streak-detector';

const fail = (error: string) => ({ calls: 1, failed: 1, errors: [error] });

describe('FailureStreakDetector', () => {
  test('nudges once, then stops, on rounds where every call failed differently', () => {
    const d = new FailureStreakDetector();
    const verdicts = Array.from({ length: FAILURE_STREAK_STOP_AT }, (_, i) => d.record(fail(`ENOENT /p${i}`)));
    expect(verdicts.slice(0, FAILURE_STREAK_NUDGE_AT - 1).every((v) => v.action === 'none')).toBe(true);
    expect(verdicts[FAILURE_STREAK_NUDGE_AT - 1]).toMatchObject({ action: 'nudge', consecutive: FAILURE_STREAK_NUDGE_AT });
    expect(verdicts.slice(FAILURE_STREAK_NUDGE_AT, -1).every((v) => v.action === 'none')).toBe(true);
    expect(verdicts.at(-1)).toMatchObject({ action: 'stop', consecutive: FAILURE_STREAK_STOP_AT });
  });

  test('one call that returned a result resets the streak', () => {
    const d = new FailureStreakDetector();
    for (let i = 0; i < FAILURE_STREAK_NUDGE_AT - 1; i++) d.record(fail('denied'));
    expect(d.record({ calls: 2, failed: 1, errors: ['denied'] })).toEqual({ action: 'none' });
    for (let i = 0; i < FAILURE_STREAK_NUDGE_AT - 1; i++) expect(d.record(fail('denied')).action).toBe('none');
    expect(d.record(fail('denied')).action).toBe('nudge');
  });

  test('a round without tool calls neither counts nor resets', () => {
    const d = new FailureStreakDetector();
    for (let i = 0; i < FAILURE_STREAK_NUDGE_AT - 1; i++) d.record(fail('x'));
    expect(d.record({ calls: 0, failed: 0, errors: [] })).toEqual({ action: 'none' });
    expect(d.record(fail('x')).action).toBe('nudge');
  });

  test('keeps the last few distinct errors, trimmed', () => {
    const d = new FailureStreakDetector();
    let v = d.record(fail('a'));
    for (const e of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) v = d.record(fail(`${e}${' '.repeat(3)}${'z'.repeat(400)}`));
    expect(v.action).toBe('stop');
    if (v.action === 'none') throw new Error('unreachable');
    expect(v.errors).toHaveLength(4);
    expect(v.errors.every((e) => e.length <= 160 && !e.includes('   '))).toBe(true);
    expect(v.errors[0].startsWith('d')).toBe(true);
  });

  test('messages name the errors and say what to do', () => {
    expect(failureStreakNudge(4, ['ENOENT /a'])).toContain('"ENOENT /a"');
    expect(failureStreakNudge(4, [])).toContain('change approach');
    expect(failureStreakStop(8, [])).toContain('Do not claim the task is done');
  });
});
