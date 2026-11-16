#!/usr/bin/env tsx
/**
 * Run the fixed-label decision sets in eval/decisions/ — no model, no backend.
 *
 * Each run stands up a throwaway embedded database (never the install's own),
 * migrates it, seeds one user, and runs every case through the production
 * check. Exit 1 on any unsafe allow, any error, or a case that was correct in
 * the committed baseline and is not now.
 *
 * Usage:
 *   npm run eval:decisions                       # every set, compared with its baseline
 *   npm run eval:decisions -- companion-authority
 *   npm run eval:decisions -- --write-baseline   # rewrite eval/results/decisions/<set>.baseline.json
 *   npm run eval:decisions -- --json
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const writeBaseline = args.includes('--write-baseline');
const jsonOnly = args.includes('--json');
const only = args.filter(a => !a.startsWith('-'));
const unknown = args.filter(a => a.startsWith('-') && a !== '--write-baseline' && a !== '--json');
if (unknown.length) {
  console.error(`Unknown option(s): ${unknown.join(', ')}`);
  process.exit(1);
}

const evalDir = resolve(process.cwd(), 'eval');
const setsDir = join(evalDir, 'decisions');
const baselineDir = join(evalDir, 'results', 'decisions');

// A database of its own, set up before any module reads the config: the sets
// insert and delete sessions, which must never touch the install's data.
const dataDir = mkdtempSync(join(tmpdir(), 'octipus-decisions-'));
const rand = () => randomBytes(24).toString('hex');
Object.assign(process.env, { STORAGE_MODE: 'embedded', DATA_DIR: dataDir, LOG_LEVEL: process.env.LOG_LEVEL ?? 'error' });
process.env.MASTER_KEY ??= `decisions-master-${rand()}`;
process.env.JWT_SECRET ??= `decisions-jwt-${rand()}`;
process.env.SESSION_SECRET ??= `decisions-session-${rand()}`;

async function main(): Promise<number> {
  const files = readdirSync(setsDir).filter(f => /\.ya?ml$/.test(f) && (!only.length || only.includes(basename(f).replace(/\.ya?ml$/, ''))));
  if (!files.length) {
    console.error(`No decision sets${only.length ? ` named ${only.join(', ')}` : ''} in ${setsDir}`);
    return 1;
  }
  const decisions = await import('./decisions');
  const { initializeDb, getDb } = await import('@/db/postgres');
  const { runMigrations } = await import('@/db/migrate');
  const { users } = await import('@/db/schema/users');
  await initializeDb();
  await runMigrations();
  const userId = randomUUID();
  await getDb().insert(users).values({ id: userId, username: `decisions-${userId.slice(0, 8)}` });

  let failed = false;
  const reports = [];
  for (const file of files) {
    const text = readFileSync(join(setsDir, file), 'utf8');
    const set = decisions.parseDecisionSet(text);
    const outcomes = await decisions.runDecisionSet(set, userId);
    const report = decisions.decisionReport(set, decisions.decisionSetFingerprint(text), outcomes);
    const baselinePath = join(baselineDir, `${set.name}.baseline.json`);
    const comparison = !writeBaseline && existsSync(baselinePath)
      ? decisions.compareDecisions(JSON.parse(readFileSync(baselinePath, 'utf8')), report)
      : undefined;
    if (decisions.decisionsFail(report.summary, comparison)) failed = true;
    if (writeBaseline) {
      mkdirSync(baselineDir, { recursive: true });
      writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
    }
    reports.push(report);
    if (!jsonOnly) {
      console.log(decisions.formatDecisionReport(report, outcomes, comparison));
      if (writeBaseline) console.log(`  baseline written: ${baselinePath}`);
      else if (!comparison) console.log('  no baseline (run with --write-baseline to commit one)');
      console.log('');
    }
  }
  if (jsonOnly) console.log(JSON.stringify(reports, null, 2));
  return failed ? 1 : 0;
}

async function cleanup() {
  try {
    const { closeDb } = await import('@/db/postgres');
    await closeDb();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main()
  .then(async code => { await cleanup(); process.exit(code); })
  .catch(async err => {
    console.error('Decision run failed:', err);
    await cleanup().catch((cleanupErr: unknown) => console.error('Cleanup failed:', cleanupErr));
    process.exit(2);
  });
