#!/usr/bin/env bun
/**
 * Gzip yesterday's trajectory JSONL file.
 * Run via cron or pipeline scheduler. Idempotent — skips if already gzipped.
 */

import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'fs';
import { gzipSync } from 'zlib';
import { trajectoryFilePathForDate } from '@/core/trajectories/recorder';

function yesterday(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

function main(): void {
  const path = trajectoryFilePathForDate(yesterday());
  const gz = `${path}.gz`;

  if (!existsSync(path)) {
    console.log(`[trajectories] no file at ${path}, skipping`);
    return;
  }
  if (existsSync(gz)) {
    console.log(`[trajectories] ${gz} already exists, removing uncompressed source`);
    unlinkSync(path);
    return;
  }

  const data = readFileSync(path);
  const compressed = gzipSync(data);
  writeFileSync(gz, compressed);
  unlinkSync(path);
  console.log(`[trajectories] compressed ${path} → ${gz} (${data.length} → ${compressed.length} bytes)`);
}

if (import.meta.main) main();
