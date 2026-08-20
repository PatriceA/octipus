/**
 * Memory-aware evals. Everything here is the part that decides whether a
 * seeded test may run at all — the half that must never quietly pass.
 */
import { describe, expect, test } from 'bun:test';
import { evaluateAssertion } from './assertions';
import { memorySetupBlocker } from './memory-setup';
import type { TestExecutionContext } from './types';

const ctx = (response?: string): TestExecutionContext => ({ latencyMs: 1, response });
const UUID = '11111111-2222-4333-8444-555555555555';

describe('memorySetupBlocker', () => {
  test('no seeds, nothing to block', () => {
    expect(memorySetupBlocker(undefined, { integration: false })).toBeNull();
    expect(memorySetupBlocker([], { integration: false })).toBeNull();
  });

  test('unit mode is refused — it never reads the memories table', () => {
    const why = memorySetupBlocker([{ factType: 'preference', content: 'x' }], {
      integration: false,
      userId: UUID,
    });
    expect(why).toContain('--integration');
  });

  test('a non-UUID user is refused before the insert fails', () => {
    const why = memorySetupBlocker([{ factType: 'preference', content: 'x' }], {
      integration: true,
      userId: 'eval-user',
    });
    expect(why).toContain('uuid');
  });

  test('integration mode with a real user id runs', () => {
    expect(
      memorySetupBlocker([{ factType: 'preference', content: 'x' }], {
        integration: true,
        userId: UUID,
      }),
    ).toBeNull();
  });
});

describe('recalls_memory', () => {
  test('passes when the seeded fact is in the reply', async () => {
    const r = await evaluateAssertion(
      { type: 'recalls_memory', value: 'Lisbon' },
      ctx('You are based in Lisbon, so 14:00 local.'),
    );
    expect(r.passed).toBe(true);
  });

  test('a partial recall is a failure, and names what is missing', async () => {
    const r = await evaluateAssertion(
      { type: 'recalls_memory', value: ['Lisbon', 'espresso'] },
      ctx('You are based in Lisbon.'),
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain('espresso');
  });

  test('an empty response never counts as recall', async () => {
    const r = await evaluateAssertion({ type: 'recalls_memory', value: 'Lisbon' }, ctx(''));
    expect(r.passed).toBe(false);
  });

  test('matching ignores case', async () => {
    const r = await evaluateAssertion(
      { type: 'recalls_memory', value: 'lisbon' },
      ctx('Lisbon it is.'),
    );
    expect(r.passed).toBe(true);
  });
});
