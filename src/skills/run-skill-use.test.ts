import { expect, test } from 'vitest';
import { runWithContext } from '@/core/run-context';
import { noteRunSkillUse, takeRunSkillUse } from './run-skill-use';

test('a skill used inside a run is noted for that run only, and read once', () => {
  runWithContext({ runId: 'run_a' }, () => noteRunSkillUse(2));
  runWithContext({ runId: 'run_b' }, () => noteRunSkillUse(0));
  expect(takeRunSkillUse('run_b')).toBe(false);
  expect(takeRunSkillUse('run_a')).toBe(true);
  expect(takeRunSkillUse('run_a')).toBe(false);
});

test('outside a run nothing is noted', () => {
  noteRunSkillUse(1);
  expect(takeRunSkillUse('undefined')).toBe(false);
});

test('runs never taken are dropped, oldest first', () => {
  for (let i = 0; i <= 1000; i++) runWithContext({ runId: `run_${i}` }, () => noteRunSkillUse(1));
  expect(takeRunSkillUse('run_0')).toBe(false);
  expect(takeRunSkillUse('run_1000')).toBe(true);
});
