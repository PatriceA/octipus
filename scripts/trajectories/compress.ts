#!/usr/bin/env bun
/**
 * Gzip yesterday's trajectory JSONL file. Idempotent — skips if already gzipped.
 * The compression logic lives in the recorder (`compressTrajectoryForDate`) and
 * also runs daily from the cron loop; this CLI is the manual/one-off entry point.
 */

import { compressTrajectoryForDate, trajectoryFilePathForDate } from '@/core/trajectories/recorder';

function yesterday(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

function main(): void {
  const date = yesterday();
  const path = trajectoryFilePathForDate(date);
  const result = compressTrajectoryForDate(date);
  switch (result) {
    case 'no-file':
      console.log(`[trajectories] no file at ${path}, skipping`);
      break;
    case 'already-compressed':
      console.log(`[trajectories] ${path}.gz already exists, removed leftover source`);
      break;
    case 'compressed':
      console.log(`[trajectories] compressed ${path} → ${path}.gz`);
      break;
  }
}

if (import.meta.main) main();
