/**
 * Durable background jobs over embedded PGlite: the claim lock, the
 * finish-only-if-running rule, the boot sweep, and the document queue
 * draining rows it did not enqueue itself (the restart case).
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const alice = '11111111-1111-1111-1111-111111111111';

// The processor is the heavy end (OCR, office parsers); the queue only needs
// it to record an outcome on the document, which is what the real one does.
const processed: string[] = [];
vi.mock('@/core/documents/processor', () => ({
  documentProcessor: {
    process: async (documentId: string) => {
      processed.push(documentId);
      const { documentRepository } = await import('@/db/repositories/document-repository');
      const doc = await documentRepository.findById(documentId);
      if (doc?.originalName === 'bad.pdf') {
        await documentRepository.updateStatus(documentId, 'failed', 'OCR model unavailable');
      } else if (doc?.originalName === 'vanish.pdf') {
        await documentRepository.delete(documentId);
      } else {
        await documentRepository.updateProcessed(documentId, { category: 'misc', ocrText: 'text', summary: 's', status: 'completed' });
      }
    },
  },
}));

let repo: typeof import('@/db/repositories/background-job-repository').backgroundJobRepository;
let docs: typeof import('@/db/repositories/document-repository').documentRepository;

async function newDocument(originalName: string): Promise<string> {
  const d = await docs.create({
    userId: alice,
    filename: `${rand(4)}.pdf`,
    originalName,
    mimeType: 'application/pdf',
    size: 1,
    storagePath: `/nowhere/${rand(4)}.pdf`,
    status: 'queued',
  });
  return d.id;
}

const settle = () => new Promise((r) => setTimeout(r, 50));
async function waitFor(pred: () => Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await settle();
  }
  throw new Error('condition not met in time');
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-jobs-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${alice}', 'alice', false)`);
  repo = (await import('@/db/repositories/background-job-repository')).backgroundJobRepository;
  docs = (await import('@/db/repositories/document-repository')).documentRepository;
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('BackgroundJobRepository', () => {
  test('claims the oldest queued row of a kind, once', async () => {
    const a = await repo.create({ kind: 'research', userId: alice, title: 'first', payload: { n: 1 } });
    const b = await repo.create({ kind: 'research', userId: alice, title: 'second', payload: { n: 2 } });
    await repo.create({ kind: 'document', userId: alice, title: 'other kind', payload: {} });

    const first = await repo.claimNext('research');
    expect(first?.id).toBe(a.id);
    expect(first?.status).toBe('running');
    expect(first?.startedAt).toBeInstanceOf(Date);
    const second = await repo.claimNext('research');
    expect(second?.id).toBe(b.id);
    expect(await repo.claimNext('research')).toBeNull();

    expect(await repo.countByStatus('research')).toEqual({ queued: 0, running: 2 });
    await repo.finish(a.id, { status: 'done', result: { ok: true }, resultRef: 'doc-a' });
    await repo.finish(b.id, { status: 'error', error: 'boom' });
    expect((await repo.findById(a.id))?.result).toEqual({ ok: true });
    expect((await repo.findById(b.id))?.error).toBe('boom');
    // Clean up the other kind for the queue tests below.
    expect(await repo.dropQueued('document', {})).toBe(1);
  });

  test('rows created inside one millisecond still claim in insertion order', async () => {
    const { getDb } = await import('@/db/postgres');
    const { backgroundJobs } = await import('@/db/schema/background-jobs');
    const at = new Date('2026-09-07T08:00:00.123Z');
    const inserted = await getDb()
      .insert(backgroundJobs)
      .values(['one', 'two', 'three'].map((title) => ({ kind: 'document' as const, userId: alice, title, payload: {}, createdAt: at, updatedAt: at })))
      .returning({ id: backgroundJobs.id, title: backgroundJobs.title });
    const order: string[] = [];
    for (;;) {
      const job = await repo.claimNext('document');
      if (!job) break;
      order.push(job.title);
      await repo.finish(job.id, { status: 'done' });
    }
    expect(order).toEqual(inserted.map((r) => r.title));
  });

  test('progress and finish only touch a running row', async () => {
    const done = await repo.create({ kind: 'research', userId: alice, title: 't', payload: {}, status: 'running' });
    await repo.progress(done.id, { stage: 'reading', detail: '3 sources' });
    expect((await repo.findById(done.id))?.stage).toBe('reading');
    expect(await repo.finish(done.id, { status: 'done' })).not.toBeNull();
    // A second finish (a worker outliving the sweep) cannot overwrite the verdict.
    expect(await repo.finish(done.id, { status: 'error', error: 'late' })).toBeNull();
    await repo.progress(done.id, { stage: 'late' });
    const row = await repo.findById(done.id);
    expect(row?.status).toBe('done');
    expect(row?.stage).toBe('done');
    expect(row?.error).toBeNull();
  });

  test('the boot sweep interrupts running rows, leaves queued ones, prunes old terminal ones', async () => {
    const running = await repo.create({ kind: 'research', userId: alice, title: 'live', payload: {}, status: 'running' });
    const queued = await repo.create({ kind: 'document', userId: alice, title: 'waiting', payload: { documentId: 'none' } });
    const old = await repo.create({ kind: 'research', userId: alice, title: 'old', payload: {}, status: 'running' });
    const { getDb } = await import('@/db/postgres');
    const { backgroundJobs } = await import('@/db/schema/background-jobs');
    const { eq } = await import('drizzle-orm');
    await getDb().update(backgroundJobs).set({ status: 'done', finishedAt: new Date('2026-01-01T00:00:00Z') }).where(eq(backgroundJobs.id, old.id));

    const { recoverBackgroundJobs } = await import('./recover');
    const report = await recoverBackgroundJobs(new Date('2026-09-07T08:00:00Z'));
    expect(report).toEqual({ interrupted: 1, pruned: 1 });
    const swept = await repo.findById(running.id);
    expect(swept?.status).toBe('interrupted');
    expect(swept?.error).toBe('Interrupted by a restart');
    expect(swept?.finishedAt?.toISOString()).toBe('2026-09-07T08:00:00.000Z');
    expect((await repo.findById(queued.id))?.status).toBe('queued');
    expect(await repo.findById(old.id)).toBeNull();
    await repo.dropQueued('document', { documentId: 'none' });
  });

  test('the sweep marks a document whose run died as failed, with the reason', async () => {
    const documentId = await newDocument('cut-off.pdf');
    await docs.updateStatus(documentId, 'processing');
    await repo.create({ kind: 'document', userId: alice, title: 'cut-off.pdf', payload: { documentId }, status: 'running' });
    const { recoverBackgroundJobs } = await import('./recover');
    await recoverBackgroundJobs();
    const doc = await docs.findById(documentId);
    expect(doc?.status).toBe('failed');
    expect((doc?.metadata as { error?: string })?.error).toBe('Interrupted by a restart');
  });
});

describe('DocumentQueue', () => {
  test('enqueue writes a row, the worker drains in order and records each outcome', async () => {
    const { getDocumentQueue } = await import('@/core/documents/queue');
    const queue = getDocumentQueue();
    const events: string[] = [];
    queue.on('completed', (id: string) => events.push(`completed:${id}`));
    queue.on('failed', (id: string, err: string) => events.push(`failed:${id}:${err}`));

    const good = await newDocument('good.pdf');
    const bad = await newDocument('bad.pdf');
    await queue.enqueue(good, alice);
    await queue.enqueue(bad, alice);
    await waitFor(async () => (await repo.countByStatus('document')).queued + (await repo.countByStatus('document')).running === 0);

    expect(processed.slice(-2)).toEqual([good, bad]);
    expect(events).toEqual([`completed:${good}`, `failed:${bad}:OCR model unavailable`]);
    const rows = await repo.recentForUser(alice, 2);
    expect(rows.map((r) => [r.payload.documentId, r.status, r.resultRef ?? r.error])).toEqual([
      [bad, 'error', 'OCR model unavailable'],
      [good, 'done', good],
    ]);
    expect(await queue.getStatus()).toEqual({ queueLength: 0, isProcessing: false, currentDocumentId: undefined });
  });

  test('removeFromQueue drops a queued row and nothing else', async () => {
    const { getDocumentQueue } = await import('@/core/documents/queue');
    const queue = getDocumentQueue();
    const documentId = await newDocument('never.pdf');
    // Insert directly so the worker is not kicked.
    await repo.create({ kind: 'document', userId: alice, title: 'never.pdf', payload: { documentId } });
    expect(await queue.removeFromQueue(documentId)).toBe(true);
    expect(await queue.removeFromQueue(documentId)).toBe(false);
    expect(processed).not.toContain(documentId);
  });

  test('a document deleted while it ran is a cancelled job, not a failure', async () => {
    const { getDocumentQueue } = await import('@/core/documents/queue');
    const queue = getDocumentQueue();
    const failures: string[] = [];
    queue.on('failed', (id: string) => failures.push(id));
    const documentId = await newDocument('vanish.pdf');
    await queue.enqueue(documentId, alice, { title: 'vanish.pdf', workspaceId: null });
    await waitFor(async () => (await repo.countByStatus('document')).queued + (await repo.countByStatus('document')).running === 0);
    const [row] = await repo.recentForUser(alice, 1);
    expect([row.payload.documentId, row.status]).toEqual([documentId, 'cancelled']);
    expect(failures).not.toContain(documentId);
  });

  test('resume drains rows a previous process left queued', async () => {
    const { getDocumentQueue } = await import('@/core/documents/queue');
    const queue = getDocumentQueue();
    const documentId = await newDocument('leftover.pdf');
    await repo.create({ kind: 'document', userId: alice, title: 'leftover.pdf', payload: { documentId } });
    queue.resume();
    await waitFor(async () => processed.includes(documentId));
    await waitFor(async () => (await repo.countByStatus('document')).running === 0);
    expect((await docs.findById(documentId))?.status).toBe('completed');
  });
});
