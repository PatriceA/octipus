import { expect, test } from 'vitest';
import { companionControllerLimits } from './turn-limits';

test('interactive Companion chats inherit normal configured limits, including unlimited budgets', () => {
  expect(companionControllerLimits('user', 16_000)).toEqual({ maxTokenBudget: undefined, maxIterations: undefined });
});
test('unattended controller turns keep their configured caps and bounded iterations', () => {
  expect(companionControllerLimits('monitor', 16_000)).toEqual({ maxTokenBudget: 16_000, maxIterations: 12 });
});
test('an allocated execution reservation remains enforced in either kind of turn', () => {
  expect(companionControllerLimits('user', 16_000, 7_000).maxTokenBudget).toBe(7_000);
  expect(companionControllerLimits('monitor', 16_000, 7_000).maxTokenBudget).toBe(7_000);
});
