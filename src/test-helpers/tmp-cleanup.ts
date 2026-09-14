/** Each Vitest invocation owns one exclusive scratch root; never sweep shared /tmp. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    testTmpRoot: string;
  }
}

export function createTestTmpRoot(parent = tmpdir()) {
  const root = mkdtempSync(join(parent, 'octipus-test-run-'));
  return {
    root,
    // Exact ownership, independent of filenames, activity times, or other runs.
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The root project's provided context is inherited by all test projects. */
export default function setup(project: Pick<TestProject, 'provide'>): () => void {
  const owned = createTestTmpRoot();
  try {
    project.provide('testTmpRoot', owned.root);
  } catch (error) {
    owned.cleanup();
    throw error;
  }
  return owned.cleanup;
}
