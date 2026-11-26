/** Each Vitest invocation owns one exclusive scratch root; never sweep shared /tmp. */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

// Test files may mock node:fs; ownership cleanup must use the real filesystem.
const { mkdtempSync, rmSync } = process.getBuiltinModule('node:fs');

declare module 'vitest' {
  export interface ProvidedContext {
    testTmpRoot: string;
  }
}

export function createTestTmpRoot(parent = tmpdir(), prefix = 'octi-t-') {
  const root = mkdtempSync(join(parent, prefix));
  return {
    root,
    // Exact ownership, independent of filenames, activity times, or other runs.
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }),
  };
}

/** Short names leave room for Unix socket paths. Every file owns scratch independently of its parallel siblings and the shared template. */
export function createTestFileTmpRoot(parent: string) {
  return createTestTmpRoot(parent, 'f-');
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
