import { expect, test } from 'vitest';
import { sessionBudgetMessage, sessionTokenBudget } from './session-budget';
test('new sessions inherit; explicit lower caps and unlimited zero win', () => {
  expect(sessionTokenBudget(null, 10_000_000)).toEqual({ cap: 10_000_000, explicit: false });
  expect(sessionTokenBudget({ tokenBudget: 1000 }, 10_000_000)).toEqual({ cap: 1000, explicit: true });
  expect(sessionTokenBudget({ tokenBudget: 0 }, 10_000_000)).toEqual({ cap: 0, explicit: true });
  for (const tokenBudget of [-1, NaN, Infinity, '0']) expect(sessionTokenBudget({ tokenBudget }, 500)).toEqual({ cap: 500, explicit: false });
});
test('session guidance identifies the applicable cap and distinguishes the daily limit', () => {
  expect(sessionBudgetMessage(200, 100, false)).toContain('Settings → System → Advanced configuration → Agent');
  expect(sessionBudgetMessage(200, 100, true)).toContain('explicit tokenBudget override');
  expect(sessionBudgetMessage(200, 100, true)).not.toContain('admin can raise agent.maxTokenBudget');
  expect(sessionBudgetMessage(200, 100, false)).toContain('does not reset daily usage');
});
