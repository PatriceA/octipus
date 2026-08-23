import { describe, expect, test } from 'vitest';
import { withFileMutationQueue } from './file-mutation-queue';

describe('File Mutation Queue', () => {
  test('sequential execution for same file path', async () => {
    const order: number[] = [];

    const op1 = withFileMutationQueue('/tmp/test-file.txt', async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
      return 'first';
    });

    const op2 = withFileMutationQueue('/tmp/test-file.txt', async () => {
      order.push(2);
      return 'second';
    });

    const [r1, r2] = await Promise.all([op1, op2]);

    expect(r1).toBe('first');
    expect(r2).toBe('second');
    expect(order).toEqual([1, 2]);
  });

  test('parallel execution for different file paths', async () => {
    const order: string[] = [];

    const op1 = withFileMutationQueue('/tmp/file-a.txt', async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push('a-done');
      return 'a';
    });

    const op2 = withFileMutationQueue('/tmp/file-b.txt', async () => {
      order.push('b-done');
      return 'b';
    });

    const [r1, r2] = await Promise.all([op1, op2]);

    expect(r1).toBe('a');
    expect(r2).toBe('b');
    // b should finish before a since it has no delay and runs in parallel
    expect(order[0]).toBe('b-done');
  });

  test('error in one operation does not block the next on the same file', async () => {
    const op1 = withFileMutationQueue('/tmp/error-file.txt', async () => {
      throw new Error('op1 failed');
    });

    await expect(op1).rejects.toThrow('op1 failed');

    const op2 = withFileMutationQueue('/tmp/error-file.txt', async () => {
      return 'recovered';
    });

    expect(await op2).toBe('recovered');
  });

  test('path normalization treats relative and absolute paths as same key', async () => {
    const order: number[] = [];

    // Both resolve to the same absolute path
    const op1 = withFileMutationQueue('/tmp/norm-test/../norm-test/file.txt', async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
      return 'first';
    });

    const op2 = withFileMutationQueue('/tmp/norm-test/file.txt', async () => {
      order.push(2);
      return 'second';
    });

    await Promise.all([op1, op2]);

    // Should be sequential (same normalized path), so order is deterministic
    expect(order).toEqual([1, 2]);
  });
});
