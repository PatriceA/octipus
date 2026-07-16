#!/usr/bin/env bun
/**
 * Export recorded trajectories as chat-format training JSONL for offline eval /
 * fine-tune pipelines. Reads the daily JSONL files (compressed or not) written
 * by the recorder, filters, re-runs the PII filter, and emits one training
 * example per run.
 *
 * Usage:
 *   bun run scripts/trajectories/export.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *                                          [--outcome success] [--out file.jsonl]
 * Without --out, writes to stdout. Always prints a summary to stderr — no
 * silent truncation.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { trajectoryFilePathForDate } from '@/core/trajectories/recorder';
import { type ExportFilters, exportFromJsonl, type TrainingExample } from '@/core/trajectories/exporter';
import type { TrajectoryOutcome } from '@/core/trajectories/types';

function parseArgs(argv: string[]): { filters: ExportFilters; out?: string } {
  const filters: ExportFilters = {};
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const val = argv[i + 1];
    if (arg === '--outcome') { filters.outcome = val as TrajectoryOutcome; i++; }
    else if (arg === '--from') { filters.from = new Date(val); i++; }
    else if (arg === '--to') { filters.to = new Date(val); i++; }
    else if (arg === '--out') { out = val; i++; }
  }
  return { filters, out };
}

function main(): void {
  const { filters, out } = parseArgs(process.argv.slice(2));
  const dir = dirname(trajectoryFilePathForDate(new Date()));

  if (!existsSync(dir)) {
    process.stderr.write(`[trajectories] no trajectories dir at ${dir}\n`);
    return;
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.gz'))
    .sort();

  const all: TrainingExample[] = [];
  let scanned = 0;
  let malformed = 0;
  let filteredOut = 0;

  for (const file of files) {
    const path = join(dir, file);
    const raw = readFileSync(path);
    const body = file.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    const res = exportFromJsonl(body, filters);
    all.push(...res.examples);
    scanned += res.scanned;
    malformed += res.malformed;
    filteredOut += res.filtered;
  }

  const output = all.map((ex) => JSON.stringify(ex)).join('\n') + (all.length ? '\n' : '');
  if (out) {
    writeFileSync(out, output);
    process.stderr.write(`[trajectories] wrote ${all.length} examples to ${out}\n`);
  } else {
    process.stdout.write(output);
  }
  process.stderr.write(
    `[trajectories] scanned ${scanned} runs across ${files.length} files — ` +
      `exported ${all.length}, filtered ${filteredOut}, malformed ${malformed}\n`,
  );
}

main();
