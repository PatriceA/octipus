/**
 * Tiny process-local pub/sub for hwfit install-job progress so the API/WS layer
 * can push updates to the browser instead of the client polling. Kept separate
 * from install.ts (which stays dependency-light + unit-testable) — install.ts
 * calls an injected `onUpdate`; the route wires that to `emitInstallProgress`.
 */
import type { InstallJob } from './install';

type InstallProgressListener = (job: InstallJob) => void;

const listeners = new Set<InstallProgressListener>();

/** Subscribe to install-job progress. Returns an unsubscribe fn. */
export function onInstallProgress(listener: InstallProgressListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Publish an install-job snapshot to all listeners. Never throws. */
export function emitInstallProgress(job: InstallJob): void {
  for (const listener of listeners) {
    try {
      listener(job);
    } catch {
      // A bad listener must not break the install or other listeners.
    }
  }
}
