/** Email triage training set: threshold fitting (pure) and the label store (embedded Postgres). */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DEFAULT_THRESHOLD, MIN_CALIBRATION, fitThreshold } from './triage-labels';
import { priorityFrom } from './service';
import type { InboxItem } from './types';

describe('fitThreshold', () => {
  test('too few labels keep the default', () => {
    expect(fitThreshold([{ confidence: 0.9, correct: true }])).toMatchObject({ threshold: DEFAULT_THRESHOLD, fitted: false, accepted: 1, accuracy: 1 });
  });

  test('picks the lowest threshold that keeps 90% accuracy', () => {
    // 0.95..0.5 all right, below 0.5 all wrong.
    const pairs = Array.from({ length: MIN_CALIBRATION + 10 }, (_, i) => {
      const confidence = 0.95 - i * 0.02;
      return { confidence, correct: confidence >= 0.5 };
    });
    const fit = fitThreshold(pairs);
    expect(fit.fitted).toBe(true);
    expect(fit.accuracy!).toBeGreaterThanOrEqual(0.9);
    expect(fit.threshold).toBeLessThan(0.5);
    expect(fit.threshold).toBeGreaterThan(0.4);
  });

  test('never accepts when no threshold reaches the target', () => {
    const pairs = Array.from({ length: MIN_CALIBRATION }, (_, i) => ({ confidence: 0.99 - i * 0.01, correct: i % 2 === 0 }));
    expect(fitThreshold(pairs).threshold).toBeGreaterThan(1);
  });
});

describe('priorityFrom', () => {
  test('no action → low; action → normal or high, resting on both answers', () => {
    expect(priorityFrom({ p: 0.1, confidence: 0.9 }, { p: 0.9, confidence: 0.2 })).toEqual({ priority: 'low', confidence: 0.9 });
    expect(priorityFrom({ p: 0.8, confidence: 0.8 }, { p: 0.3, confidence: 0.7 })).toEqual({ priority: 'normal', confidence: 0.7 });
    expect(priorityFrom({ p: 0.95, confidence: 0.95 }, { p: 0.9, confidence: 0.9 })).toEqual({ priority: 'high', confidence: 0.9 });
  });
});

process.env.STORAGE_MODE = 'embedded';
const dir = mkdtempSync(join(tmpdir(), 'octipus-triage-labels-'));
process.env.DATA_DIR = dir;
process.env.LOG_LEVEL = 'error';
const owner = randomUUID();
const mail = (id: string, from: string): InboxItem => ({ id, provider: 'google', from: { email: from }, subject: `subject ${id}`, snippet: `snippet ${id}`, receivedAt: '', unread: false });
const clef = (priority: 'low' | 'normal' | 'high', confidence: number) => ({ model: 'clef', rubric: 'r1', priority, priorityConfidence: confidence, category: 'work', categoryConfidence: confidence, at: '' });

describe('label store', () => {
  beforeAll(async () => {
    const { initializeDb } = await import('@/db/postgres');
    await initializeDb();
    await (await import('@/db/migrate')).runMigrations();
    await (await import('@/test-helpers/multiuser-fixtures')).seedUsers([{ id: owner, username: 'triage-owner' }]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('owner labels survive model labels, win in triage, and come first as examples', async () => {
    const store = await import('./triage-labels');
    const a = mail('a', 'boss@acme.com'), b = mail('b', 'boss@acme.com'), c = mail('c', 'hr@acme.com'), d = mail('d', 'news@else.org');
    await store.saveObservations(owner, 'google', [a, b, c, d], { a: clef('high', 0.4), b: clef('low', 0.95), c: clef('normal', 0.9), d: clef('low', 0.5) });
    await store.saveModelLabels(owner, 'google', [a, b, c, d], {
      a: { priority: 'normal', category: 'work' }, b: { priority: 'low', category: 'work' },
      c: { priority: 'normal', category: 'work' }, d: { priority: 'low', category: 'promotion' },
    }, 'ref-model', 'r1');
    expect(await store.setUserLabel(owner, 'a', { priority: 'high', category: 'work' })).toBe(true);
    expect(await store.setUserLabel(owner, 'unseen', { priority: 'high', category: 'work' })).toBe(false);
    // A later model run must not overwrite the owner.
    await store.saveModelLabels(owner, 'google', [a], { a: { priority: 'low', category: 'spam' } }, 'ref-model', 'r1');
    expect(await store.userLabels(owner, 'google', ['a', 'b'])).toEqual({ a: { priority: 'high', category: 'work' } });

    const examples = await store.examplesFor(owner, mail('new', 'boss@acme.com'));
    expect(examples.map(e => e.subject)).toEqual(['subject a', 'subject b', 'subject c']);
    expect(examples[0].labelledBy).toBe('owner');
    // Never the mail itself.
    expect((await store.examplesFor(owner, b)).map(e => e.subject)).not.toContain('subject b');

    const review = await store.reviewQueue(owner, 'r1');
    // b and c: confident and agreeing (default threshold 0.7); a: owner-labelled; d: unsure.
    expect(review.items.map(i => i.messageId)).toEqual(['d']);
    expect(review.stats).toMatchObject({ labelledByOwner: 1, labelledByModel: 3 });

    // Under a new rubric only the owner's label and labels given under it count.
    await store.saveObservations(owner, 'google', [a, b, c], { a: { ...clef('high', 0.9), rubric: 'r2' }, b: { ...clef('low', 0.9), rubric: 'r2' }, c: { ...clef('normal', 0.9), rubric: 'r2' } });
    await store.saveModelLabels(owner, 'google', [c], { c: { priority: 'normal', category: 'work' } }, 'ref-model', 'r2');
    expect((await store.reviewQueue(owner, 'r2')).stats.fit.priority.labelled).toBe(2); // a (owner), c (r2); b's r1 label is ignored
    // Labels written before the new answer survive it (the backlog labels first).
    expect((await store.reviewQueue(owner, 'r2')).items.find(i => i.messageId === 'c')).toBeUndefined();
  });

  test('two accounts of one provider keep their triage apart; the default account keeps the bare key', async () => {
    const store = await import('./triage-labels');
    const { inMailbox } = await import('./account-context');
    const { getDb } = await import('@/db/postgres');
    const { emailTriageLabels } = await import('@/db/schema/email-triage-labels');
    const { eq } = await import('drizzle-orm');
    const second = { provider: 'google' as const, account: 'me@work.example' };
    const m = mail('same-id', 'x@y.org');
    // The same message id in both mailboxes: two rows, never one overwritten by the other.
    await store.saveTriageResults(owner, 'google', [m], { 'same-id': { priority: 'high' } }, () => 'llm');
    await inMailbox(second, () => store.saveTriageResults(owner, 'google', [m], { 'same-id': { priority: 'low' } }, () => 'decision'));
    expect(await store.storedTriage(owner, 'google', ['same-id'])).toEqual({ 'same-id': { priority: 'high', source: 'llm' } });
    expect(await inMailbox(second, () => store.storedTriage(owner, 'google', ['same-id']))).toEqual({ 'same-id': { priority: 'low', source: 'decision' } });
    // The owner's label in one account does not reach the other.
    await inMailbox(second, () => store.upsertUserLabel(owner, 'google', m, { priority: 'normal', category: 'work' }));
    expect(await store.userLabels(owner, 'google', ['same-id'])).toEqual({});
    expect(await inMailbox(second, () => store.userLabels(owner, 'google', ['same-id']))).toEqual({ 'same-id': { priority: 'normal', category: 'work' } });
    const keys = (await getDb().select({ provider: emailTriageLabels.provider }).from(emailTriageLabels).where(eq(emailTriageLabels.messageId, 'same-id'))).map(r => r.provider).sort();
    expect(keys).toEqual(['google', 'google:me@work.example']);
  });

  test('IMAP mail is kept under its mailbox key, apart from provider mail with the same id', async () => {
    const store = await import('./triage-labels');
    const box = `imap:${randomUUID()}` as const;
    const x: InboxItem = { ...mail('x', 'clerk@office.example'), provider: 'imap', mailbox: box };
    await store.saveTriageResults(owner, box, [x], { x: { priority: 'high', category: 'work' } }, () => 'llm', 'r1');
    await store.saveTriageResults(owner, 'google', [mail('x', 'other@else.org')], { x: { priority: 'low', category: 'promotion' } }, () => 'decision');
    expect(await store.storedTriage(owner, box, ['x'])).toEqual({ x: { priority: 'high', category: 'work', source: 'llm' } });
    expect((await store.storedTriage(owner, 'google', ['x'])).x).toMatchObject({ priority: 'low', source: 'decision' });
    // The owner's own label, on a mail of this mailbox only.
    await store.upsertUserLabel(owner, box, x, { priority: 'normal', category: 'personal' });
    expect(await store.storedTriage(owner, box, ['x'])).toEqual({ x: { priority: 'normal', category: 'personal', source: 'owner' } });
    expect((await store.storedTriage(owner, 'google', ['x'])).x.priority).toBe('low');
    expect(await store.userLabels(owner, box, ['x'])).toEqual({ x: { priority: 'normal', category: 'personal' } });
    // A sender is the same sender in every mailbox: the label is a worked example for their next mail anywhere.
    expect((await store.examplesFor(owner, mail('y', 'clerk@office.example')))[0]).toMatchObject({ priority: 'normal', labelledBy: 'owner' });
  });
});
