import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('weekly review', () => {
  const userId = randomUUID();
  let assembleReviewContext: typeof import('./weekly-review').assembleReviewContext;
  let generateWeeklyReview: typeof import('./weekly-review').generateWeeklyReview;
  let renderReviewPrompt: typeof import('./weekly-review').renderReviewPrompt;
  let svc: import('./notes').NoteService;
  let links: import('@/db/repositories/knowledge-link-repository').KnowledgeLinkRepository;

  beforeAll(async () => {
    process.env.STORAGE_MODE = 'embedded';
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-review-'));
    const { initializeDb } = await import('@/db/postgres');
    await initializeDb();
    const { runMigrations } = await import('@/db/migrate');
    await runMigrations();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: userId, username: 'review-user' }]);
    const mod = await import('./weekly-review');
    assembleReviewContext = mod.assembleReviewContext;
    generateWeeklyReview = mod.generateWeeklyReview;
    renderReviewPrompt = mod.renderReviewPrompt;
    svc = (await import('./notes')).getNoteService();
    links = new (await import('@/db/repositories/knowledge-link-repository')).KnowledgeLinkRepository();
  });

  afterAll(async () => {
    const { closeDb } = await import('@/db/postgres');
    await closeDb();
  });

  beforeEach(async () => {
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw('TRUNCATE TABLE notes');
    await executeRaw('TRUNCATE TABLE knowledge_links');
  });

  test('assembleReviewContext includes only in-window daily notes', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const old = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    await svc.getOrCreateDaily(userId, null, today);
    await svc.getOrCreateDaily(userId, null, old);
    const ctx = await assembleReviewContext(userId, new Date());
    expect(ctx.dailyNotes.map((n) => n.slug)).toContain(`daily/${today}`);
    expect(ctx.dailyNotes.map((n) => n.slug)).not.toContain(`daily/${old}`);
  });

  test('renderReviewPrompt notes an empty week', () => {
    const out = renderReviewPrompt({ start: '2026-06-01', end: '2026-06-07', dailyNotes: [], completedTasks: [], newMemories: [] });
    expect(out).toContain('No recorded activity');
  });

  test('generateWeeklyReview writes a linked review note via a fake model', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await svc.capture(userId, null, 'shipped the [[Knowledge Graph]] feature', today);

    const result = await generateWeeklyReview(userId, null, {
      resolveModelId: async () => 'fake-model',
      complete: async (req) => {
        // The assembled material should have reached the prompt.
        expect(req.messages[1].content).toContain('Knowledge Graph');
        return { content: '## Themes\nShipped [[Knowledge Graph]].\n' };
      },
    });

    const note = await svc.getById(userId, result.noteId);
    expect(note?.noteKind).toBe('moc');
    expect(note?.slug).toMatch(/^reviews\/week-of-/);
    // The review's [[Knowledge Graph]] wikilink is wired into the graph.
    const refs = (await links.getOutgoing(userId, 'note', result.noteId)).map((e) => e.toRef);
    expect(refs).toContain('knowledge-graph');
  });

  test('generateWeeklyReview fails loud when the topic is unbound', async () => {
    await expect(
      generateWeeklyReview(userId, null, { resolveModelId: async () => null }),
    ).rejects.toThrow(/knowledge_review/);
  });
});
