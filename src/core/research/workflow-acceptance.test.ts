import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runResearch } from './service';
import { persistReport } from './persist';
import { createTasksFromSource, backgroundUserPrincipal, researchFollowUpTask } from '@/core/tasks/sourced';
import { backgroundJobRepository } from '@/db/repositories/background-job-repository';
import { documentRepository } from '@/db/repositories/document-repository';
import { recoverBackgroundJobs } from '@/core/jobs/recover';
import { scopedRepos } from '@/db/repositories/scoped';

const userId = '11111111-1111-1111-1111-111111111111';
const sourceUrl = 'https://fixture.example/report';
const sourceBody = 'The controlled research fixture measured 42 completed tasks. The measurement covers one day.';
beforeAll(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'octipus-workflow-'));
  process.env.STORAGE_MODE = 'embedded'; process.env.DATA_DIR = join(directory, 'db');
  process.env.DOCUMENTS_PATH = join(directory, 'documents');
  const { resetConfig } = await import('@/config'); resetConfig();
  const { initializeDb } = await import('@/db/postgres'); await initializeDb();
  const { runMigrations } = await import('@/db/migrate'); await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'workflow' }]);
});
afterAll(async () => { const { closeDb } = await import('@/db/postgres'); await closeDb(); });

test('research produces a saved, source-linked document and a retry-safe follow-up task', async () => {
  const fetched: string[] = [];
  const report = await runResearch('How many tasks were completed?', 'quick', {
    now: () => '2026-09-10T10:00:00Z',
    search: async () => [{ url: sourceUrl, title: 'Controlled measurement', snippet: sourceBody }],
    fetchText: async url => { fetched.push(url); expect(url).toBe(sourceUrl); return sourceBody; },
    complete: async (_system, user) => {
      if (user.startsWith('Return a JSON array')) return '["completed task measurement"]';
      const id = user.match(/id="(s[0-9a-f]{8})"/)?.[1]; expect(id).toBeTruthy();
      return JSON.stringify({ sections: [{ heading: 'Result', markdown: '42 tasks were completed.', citations: [id] }], limitations: 'One-day fixture; no broader claim.' });
    },
  });
  expect(fetched).toContain(sourceUrl);
  expect(report.sources[0].hash).toBe(createHash('sha256').update(sourceBody).digest('hex'));
  const id = await persistReport(report, userId); expect(id).toBeTruthy();
  const document = await documentRepository.findById(id!); expect(document?.status).toBe('completed');
  const content = await readFile(document!.storagePath, 'utf8');
  expect(content).toContain('42 tasks'); expect(content).toContain(sourceUrl); expect(content).toContain('One-day fixture');
  const principal = backgroundUserPrincipal(userId);
  const input = researchFollowUpTask(report, id);
  const [first, retried] = await Promise.all([
    createTasksFromSource(principal, 'research', [input]),
    createTasksFromSource(principal, 'research', [input]),
  ]);
  expect(first[0].id).toBe(retried[0].id);
  const stored = await scopedRepos(principal).tasks.findById(first[0].id);
  expect(stored?.userId).toBe(userId); expect(stored?.sourceRef?.documentId).toBe(id);
  expect(stored?.source).toBe('research');
});

test('boot recovery preserves a finished job and interrupts a running job without false completion', async () => {
  const running = await backgroundJobRepository.create({ kind: 'research', userId, title: 'Interrupted', payload: {}, status: 'running' });
  const done = await backgroundJobRepository.create({ kind: 'research', userId, title: 'Finished', payload: {}, status: 'running' });
  await backgroundJobRepository.finish(done.id, { status: 'done', result: { answer: 42 } });
  await recoverBackgroundJobs();
  const stopped = await backgroundJobRepository.findById(running.id);
  expect(stopped?.status).toBe('interrupted'); expect(stopped?.error).toContain('restart');
  expect((await backgroundJobRepository.findById(done.id))?.status).toBe('done');
  expect(await backgroundJobRepository.finish(running.id, { status: 'done' })).toBeNull();
});
