import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasBuilder } from './canvas';
import type { NoteService } from './notes';

describe('CanvasBuilder', () => {
  const userId = randomUUID();
  let builder: CanvasBuilder;
  let svc: NoteService;

  beforeAll(async () => {
    process.env.STORAGE_MODE = 'embedded';
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-canvas-'));
    const { initializeDb } = await import('@/db/postgres');
    await initializeDb();
    const { runMigrations } = await import('@/db/migrate');
    await runMigrations();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: userId, username: 'canvas-user' }]);
    builder = (await import('./canvas')).getCanvasBuilder();
    // Stub the embedding network seam (see notes.test.ts): without it, each
    // svc.save() fires a real embed to the absent LiteLLM proxy, retries ~6s,
    // and times out under the full suite — flaky in CI.
    const { EmbeddingService } = await import('@/core/rag/embeddings');
    const embeddings = new EmbeddingService('test-model');
    spyOn(embeddings, 'generateEmbedding').mockRejectedValue(
      new Error('No embedding model configured (test) — re-index degrades to indexed:false'),
    );
    // indexText embeds in batches, so `embedBatch` is the seam that must fail
    // locally too — otherwise indexing reaches a configured proxy for real.
    spyOn(embeddings, 'embedBatch').mockImplementation(async (texts: string[]) =>
      texts.map(() => new Error('No embedding model configured (test) — re-index degrades to indexed:false')),
    );
    svc = new (await import('./notes')).NoteService(undefined, undefined, embeddings);
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

  test('projects a note neighbourhood into valid JSON Canvas', async () => {
    const a = await svc.save({ userId, title: 'Hub', body: 'links [[Spoke]]' });
    const spoke = await svc.save({ userId, title: 'Spoke' });

    const canvas = await builder.fromNeighbourhood(userId, { type: 'note', id: a.note.id }, 1);

    // Shape: spec-required node fields.
    for (const n of canvas.nodes) {
      expect(typeof n.id).toBe('string');
      expect(['text', 'file', 'link', 'group']).toContain(n.type);
      expect(typeof n.x).toBe('number');
      expect(typeof n.width).toBe('number');
    }
    // Hub (entry) + Spoke present; the file node points at the slug.
    const hub = canvas.nodes.find((n) => n['octipus:entityRef']?.id === a.note.id);
    const spokeNode = canvas.nodes.find((n) => n['octipus:entityRef']?.id === spoke.note.id);
    expect(hub).toBeDefined();
    expect(spokeNode?.file).toBe('spoke.md');
    // One edge Hub → Spoke.
    expect(canvas.edges.length).toBe(1);
    expect(canvas.edges[0].toEnd).toBe('arrow');
  });

  test('entry-only canvas when the note has no links', async () => {
    const lone = await svc.save({ userId, title: 'Lonely' });
    const canvas = await builder.fromNeighbourhood(userId, { type: 'note', id: lone.note.id }, 1);
    expect(canvas.nodes).toHaveLength(1);
    expect(canvas.edges).toHaveLength(0);
  });
});
