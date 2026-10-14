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
  const tail = prev.then(() => gate);
  queues.set(key, tail);

  // Wait for previous operation on this file to complete
  await prev;

  try {
    return await fn();
  } finally {
    release();
    // Last in line: nothing waits on this file, so its entry goes (one per
    // file ever touched otherwise stayed for the life of the process).
    if (queues.get(key) === tail) queues.delete(key);
  }
}

/** How many files have an operation running or waiting (tests). */
export function pendingFileQueues(): number {
  return queues.size;
}
