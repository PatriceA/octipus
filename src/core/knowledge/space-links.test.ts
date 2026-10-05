/**
 * Link resolution never crosses personal and space scopes
 * (docs/plans/coworking-spec.md §5.5, §5.11).
 *
 *   - a `[[Budget]]` written in a space binds to the space's "Budget", never
 *     to the author's personal "Budget", and the reverse;
 *   - a note created later in one scope reclaims only that scope's ghosts;
 *   - another member's edit keeps one edge set (edges belong to the note's
 *     author) and the scope's counts stay separate;
 *   - a viewer cannot write a space note, and vault sync stays personal.
 *
 * Backed by ephemeral PGlite; no embedding model (indexing degrades, logged).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { NoteScope } from '@/db/repositories/note-repository';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';

const alice = randomUUID();
const bob = randomUUID();
const vera = randomUUID();
let spaceId: string;
let space: NoteScope;
let bobInSpace: NoteScope;
let veraInSpace: NoteScope;
let personal: NoteScope;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-space-links-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: alice, username: 'l-alice' }, { id: bob, username: 'l-bob' }, { id: vera, username: 'l-vera' }]);
  const { spaceWith, resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
  spaceId = await spaceWith(alice, [[bob, 'editor'], [vera, 'viewer']]);
  const { contentRepos } = await import('@/db/repositories/content');
  space = contentRepos(await resolvedPrincipal(alice, spaceId)).noteScope;
  bobInSpace = contentRepos(await resolvedPrincipal(bob, spaceId)).noteScope;
  veraInSpace = contentRepos(await resolvedPrincipal(vera, spaceId)).noteScope;
  personal = contentRepos(await resolvedPrincipal(alice, null)).noteScope;
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function outgoingTarget(scope: NoteScope, noteId: string): Promise<string | null> {
  const { getKnowledgeLinkRepository } = await import('@/db/repositories/knowledge-link-repository');
  const edges = await getKnowledgeLinkRepository().getOutgoing(scope, 'note', noteId);
  return edges.find((e) => e.linkType === 'references')?.toId ?? null;
}

describe('link resolution stays inside one scope', () => {
  test('a space link never binds to a personal note, and a personal link never to a space note', async () => {
    const { getNoteService } = await import('./notes');
    const svc = getNoteService();
    const personalBudget = await svc.save({ scope: personal, title: 'Budget' });
    const spacePlan = await svc.save({ scope: space, title: 'Plan', body: 'see [[Budget]]' });
    expect(spacePlan.note.workspaceId).toBe(spaceId);
    // Alice owns a "Budget" note personally: the space link stays a ghost.
    expect(await outgoingTarget(space, spacePlan.note.id)).toBeNull();

    // The space's own "Budget" (written by another member) reclaims it…
    const spaceBudget = await svc.save({ scope: bobInSpace, title: 'Budget' });
    expect(spaceBudget.note.id).not.toBe(personalBudget.note.id);
    expect(await outgoingTarget(space, spacePlan.note.id)).toBe(spaceBudget.note.id);

    // …and a personal link to [[Budget]] binds to the personal note, not the space's.
    const personalPlan = await svc.save({ scope: personal, title: 'My plan', body: 'see [[Budget]]' });
    expect(await outgoingTarget(personal, personalPlan.note.id)).toBe(personalBudget.note.id);

    // Saving the space "Budget" again does not reach into the personal edges.
    await svc.save({ scope: bobInSpace, id: spaceBudget.note.id, title: 'Budget', body: 'updated', baseSha256: spaceBudget.note.bodySha256 });
    expect(await outgoingTarget(personal, personalPlan.note.id)).toBe(personalBudget.note.id);
  });

  test('a personal ghost is not bound by a space note of that slug, nor the reverse', async () => {
    const { getNoteService } = await import('./notes');
    const svc = getNoteService();
    const personalGhost = await svc.save({ scope: personal, title: 'Roadmap note', body: '[[Roadmap]]' });
    const spaceGhost = await svc.save({ scope: space, title: 'Space roadmap note', body: '[[Roadmap]]' });
    const spaceRoadmap = await svc.save({ scope: bobInSpace, title: 'Roadmap' });
    expect(await outgoingTarget(personal, personalGhost.note.id)).toBeNull();
    expect(await outgoingTarget(space, spaceGhost.note.id)).toBe(spaceRoadmap.note.id);
    const personalRoadmap = await svc.save({ scope: personal, title: 'Roadmap' });
    expect(await outgoingTarget(personal, personalGhost.note.id)).toBe(personalRoadmap.note.id);
    expect(await outgoingTarget(space, spaceGhost.note.id)).toBe(spaceRoadmap.note.id);
  });

  test('backlinks, slugs and unresolved counts are per scope', async () => {
    const { getKnowledgeLinkRepository } = await import('@/db/repositories/knowledge-link-repository');
    const { getNoteService } = await import('./notes');
    const svc = getNoteService();
    await svc.save({ scope: space, title: 'Dangling', body: '[[Nowhere in the space]]' });
    const links = getKnowledgeLinkRepository();
    const before = await links.countUnresolved(personal);
    await svc.save({ scope: personal, title: 'Dangling too', body: '[[Nowhere personal]]' });
    expect(await links.countUnresolved(personal)).toBe(before + 1);
    expect(await links.countUnresolved(space)).toBeGreaterThan(0);
    // Personal reads never list a space note, even the author's own.
    const personalTitles = (await svc.list(personal)).map((n) => n.title);
    expect(personalTitles).not.toContain('Plan');
    expect((await svc.getBySlug(personal, 'plan'))).toBeNull();
    expect((await svc.getBySlug(bobInSpace, 'plan'))?.workspaceId).toBe(spaceId);
  });

  test('another member’s edit keeps one edge set, owned by the note’s author', async () => {
    const { getKnowledgeLinkRepository } = await import('@/db/repositories/knowledge-link-repository');
    const { getNoteService } = await import('./notes');
    const svc = getNoteService();
    const note = await svc.save({ scope: space, title: 'Shared', body: '[[A]] [[B]]' });
    await svc.save({ scope: bobInSpace, id: note.note.id, title: 'Shared', body: '[[A]] [[C]]', baseSha256: note.note.bodySha256 });
    const refs = (await getKnowledgeLinkRepository().getOutgoing(space, 'note', note.note.id))
      .filter((e) => e.linkType === 'references').map((e) => [e.toRef, e.userId]);
    expect(refs.sort()).toEqual([['a', alice], ['c', alice]]);
  });

  test('a viewer cannot write a space note; vault export is personal-only', async () => {
    const { getNoteService } = await import('./notes');
    const { SpaceError } = await import('@/security/space-access');
    await expect(getNoteService().save({ scope: veraInSpace, title: 'Nope' })).rejects.toBeInstanceOf(SpaceError);
    const { personalNoteScope } = await import('@/db/repositories/note-repository');
    // Vault sync exports user-level notes; a space note never.
    await getNoteService().save({ scope: personalNoteScope(alice), title: 'Vaulted' });
    const { VaultSync } = await import('./vault');
    const dir = mkdtempSync(join(tmpdir(), 'octipus-vault-'));
    const { readdir } = await import('node:fs/promises');
    await new VaultSync().exportVault(alice, dir);
    const files = await readdir(dir);
    expect(files).toEqual(['vaulted.md']);
  });

  test('a live note’s reindex is billed to the install, in the space, for its last editor', async () => {
    const { NoteService } = await import('./notes');
    const { recordProviderUsage } = await import('@/models/providers/instrumented');
    const { getDocHub } = await import('@/core/docs');
    const { getKnowledgeLinkRepository } = await import('@/db/repositories/knowledge-link-repository');
    const { getNoteRepository } = await import('@/db/repositories/note-repository');
    const { getLinkResolverService } = await import('./link-resolver');
    // The embedding call records its usage the way an instrumented provider
    // does: the ambient usage context fills in user, workspace and funding.
    const embeddings = {
      deleteBySource: async () => undefined,
      indexText: async () => {
        await recordProviderUsage({ model: 'reindex-test-embed', requestType: 'embedding', messages: [] }, 'test',
          { usage: { inputTokens: 12, outputTokens: 0, totalTokens: 12 }, model: 'reindex-test-embed' });
      },
    } as unknown as import('@/core/rag/embeddings').EmbeddingService;
    const svc = new NoteService(getNoteRepository(), getKnowledgeLinkRepository(), embeddings, getLinkResolverService(), getDocHub);
    const note = await svc.save({ scope: space, title: 'Reindexed', body: 'live text' });
    await svc.refreshSpaceNote(note.note.id, bob);

    const { getDb } = await import('@/db/postgres');
    const { costLog } = await import('@/db/schema/models');
    const { eq } = await import('drizzle-orm');
    const rows = await getDb().select().from(costLog).where(eq(costLog.modelName, 'reindex-test-embed'));
    const reindex = rows.filter((r) => (r.metadata as Record<string, unknown>)?.purpose === 'live-note-reindex');
    expect(reindex.length).toBeGreaterThan(0);
    for (const row of reindex) {
      expect(row).toMatchObject({ userId: bob, workspaceId: spaceId, funding: 'install' });
      expect((row.metadata as Record<string, unknown>).noteId).toBe(note.note.id);
    }
  });
});
