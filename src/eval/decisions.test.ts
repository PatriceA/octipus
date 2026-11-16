/**
 * The Companion authority decision set, run through the production basis
 * check on an embedded database — the same run as `npm run eval:decisions`,
 * so CI fails when a change lets an unlabelled quote through or drifts from
 * the committed baseline.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  compareDecisions, type DecisionOutcome, type DecisionReport, decisionReport, decisionSetFingerprint, decisionsFail,
  parseDecisionSet, runDecisionSet, summarizeDecisions,
} from './decisions';

process.env.STORAGE_MODE = 'embedded';
const dir = mkdtempSync(join(tmpdir(), 'octipus-eval-decisions-'));
process.env.DATA_DIR = dir;
process.env.LOG_LEVEL = 'error';
const owner = randomUUID();

const setPath = resolve('eval/decisions/companion-authority.yaml');
const baselinePath = resolve('eval/results/decisions/companion-authority.baseline.json');

beforeAll(async () => {
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  await (await import('@/db/migrate')).runMigrations();
  await (await import('@/test-helpers/multiuser-fixtures')).seedUsers([{ id: owner, username: 'decisions-owner' }]);
}, 120000);
afterAll(async () => { await (await import('@/db/postgres')).closeDb(); rmSync(dir, { recursive: true, force: true }); });

describe('companion-authority decision set', () => {
  test('no unsafe allow outside the documented gap, no extra refusal, and the committed baseline still holds', async () => {
    const text = readFileSync(setPath, 'utf8');
    const set = parseDecisionSet(text);
    const outcomes = await runDecisionSet(set, owner);
    const report = decisionReport(set, decisionSetFingerprint(text), outcomes);
    expect(outcomes.filter(o => !o.correct && !o.knownGap)).toEqual([]);
    expect(report.summary).toMatchObject({ unsafeAllows: report.summary.knownGapUnsafeAllows, extraRefusals: 0, errors: 0 });
    expect(report.summary.holdout.cases).toBeGreaterThanOrEqual(10);

    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as DecisionReport;
    const comparison = compareDecisions(baseline, report);
    // A changed set needs `npm run eval:decisions -- --write-baseline` in the same change.
    expect(comparison).toEqual({ regressions: [], fixed: [], setChanged: false });
    expect(decisionsFail(report.summary, comparison)).toBe(false);
    expect(report).toEqual(baseline);
  });

  test('each case runs in its own conversation, which is removed afterwards', async () => {
    const { getDb } = await import('@/db/postgres');
    const { sessions } = await import('@/db/schema/sessions');
    const { eq } = await import('drizzle-orm');
    const set = parseDecisionSet(readFileSync(setPath, 'utf8'));
    await runDecisionSet({ ...set, cases: set.cases.slice(0, 2) }, owner);
    expect(await getDb().select().from(sessions).where(eq(sessions.userId, owner))).toEqual([]);
  });
});

describe('decision bookkeeping', () => {
  const o = (id: string, expected: 'allow' | 'refuse', actual: DecisionOutcome['actual'], extra: Partial<DecisionOutcome> = {}): DecisionOutcome => ({
    id, group: 'base', expected, actual, correct: expected === actual,
    unsafe: expected === 'refuse' && actual === 'allow', extraRefusal: expected === 'allow' && actual === 'refuse', ...extra,
  });

  test('unsafe allows and extra refusals are counted apart, per group', () => {
    const s = summarizeDecisions([o('a', 'refuse', 'allow'), o('b', 'allow', 'refuse'), o('c', 'allow', 'allow', { group: 'holdout' }),
      o('d', 'refuse', 'error', { group: 'holdout' }), o('e', 'refuse', 'allow', { group: 'holdout', knownGap: true })]);
    expect(s).toMatchObject({ cases: 5, correct: 1, unsafeAllows: 2, knownGapUnsafeAllows: 1, extraRefusals: 1, errors: 1 });
    expect(s.base).toMatchObject({ cases: 2, unsafeAllows: 1, extraRefusals: 1 });
    expect(s.holdout).toMatchObject({ cases: 3, correct: 1, errors: 1, knownGapUnsafeAllows: 1 });
  });

  test('a run fails on any unsafe allow outside a known gap, on an error, or on a regression against the baseline', () => {
    const fails = (outcomes: DecisionOutcome[], baseline?: DecisionOutcome[]) => {
      const set = { name: 's', cases: [] };
      const now = decisionReport(set, 'f', outcomes);
      return decisionsFail(now.summary, baseline ? compareDecisions(decisionReport(set, 'f', baseline), now) : undefined);
    };
    expect(fails([o('a', 'refuse', 'refuse'), o('b', 'allow', 'refuse')])).toBe(false);
    expect(fails([o('a', 'refuse', 'allow')])).toBe(true);
    expect(fails([o('a', 'refuse', 'allow', { knownGap: true })])).toBe(false);
    expect(fails([o('a', 'refuse', 'error')])).toBe(true);
    expect(fails([o('b', 'allow', 'refuse')], [o('b', 'allow', 'allow')])).toBe(true);
  });

  test('the set file is validated: unknown fields, actions and duplicate ids are refused', () => {
    const base = 'name: s\ncases:\n  - id: a\n    group: base\n    action: message_session\n    basis: x\n    expected: refuse\n';
    expect(parseDecisionSet(base).cases[0]).toMatchObject({ trigger: 'user', conversation: [] });
    expect(() => parseDecisionSet(base.replace('message_session', 'delete_everything'))).toThrow('Invalid decision set');
    expect(() => parseDecisionSet(`${base}    surprise: 1\n`)).toThrow('Invalid decision set');
    expect(() => parseDecisionSet(`${base}  - id: a\n    group: base\n    action: message_session\n    basis: x\n    expected: allow\n`)).toThrow('Duplicate case id');
  });
});
