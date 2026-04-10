import { resolve } from 'path';

/**
 * Per-file mutation queue. Ensures operations on the same file execute
 * sequentially (preventing race conditions on concurrent edits) while
 * different files run in parallel.
 */

const queues = new Map<string, Promise<void>>();

function normalizeKey(filePath: string): string {
  return resolve(filePath).toLowerCase();
}

export async function withFileMutationQueue<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = normalizeKey(filePath);
  const prev = queues.get(key) ?? Promise.resolve();

  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });

  // Chain this operation after the previous one for this file
  queues.set(key, prev.then(() => gate));

  // Wait for previous operation on this file to complete
  await prev;

  try {
    return await fn();
  } finally {
    release();
  }
}
