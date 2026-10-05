/**
 * Edit proposals (docs/plans/coworking-spec.md §7.4, §7.6 tests), service
 * level: one pending proposal per note and session, accepted through the
 * hub's merge when its base still merges, else `stale` with the three-way
 * view; rejected; decided only by members who may write.
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

const alice = randomUUID();
const bob = randomUUID();
const vera = randomUUID();
let aliceScope: NoteScope;
let bobScope: NoteScope;
let veraScope: NoteScope;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-edit-proposals-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: alice, username: 'p-alice' }, { id: bob, username: 'p-bob' }, { id: vera, username: 'p-vera' }]);
  const { spaceWith, resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
  const spaceId = await spaceWith(alice, [[bob, 'editor'], [vera, 'viewer']]);
  const { contentRepos } = await import('@/db/repositories/content');
  aliceScope = contentRepos(await resolvedPrincipal(alice, spaceId)).noteScope;
  bobScope = contentRepos(await resolvedPrincipal(bob, spaceId)).noteScope;
  veraScope = contentRepos(await resolvedPrincipal(vera, spaceId)).noteScope;
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function note(body: string) {
  const { getNoteService } = await import('@/core/knowledge/notes');
  return (await getNoteService().save({ scope: aliceScope, title: `Doc ${rand(4)}`, body })).note;
}

async function bodyOf(id: string): Promise<string> {
  const { getNoteService } = await import('@/core/knowledge/notes');
  return (await getNoteService().getById(aliceScope, id))!.body;
}

describe('edit proposals', () => {
  test('one pending proposal per note and session; accepting applies it with a proposal revision', async () => {
    const { proposeNoteEdit, listNoteProposals, acceptProposal } = await import('./edit-proposals');
    const n = await note('intro\n\nbody\n');
    const session = randomUUID();
    const first = await proposeNoteEdit(bobScope, { noteId: n.id, sessionId: session, agentId: 'agent-1', action: 'edit', baseBody: n.body, baseSha256: n.bodySha256, body: 'intro\n\nbody v1\n' });
    const second = await proposeNoteEdit(bobScope, { noteId: n.id, sessionId: session, agentId: 'agent-1', action: 'edit', baseBody: n.body, baseSha256: n.bodySha256, body: 'intro\n\nbody v2\n' });
    expect(second.id).toBe(first.id);
    const pending = await listNoteProposals(aliceScope, { noteId: n.id, status: 'pending' });
    expect(pending.map((p) => p.body)).toEqual(['intro\n\nbody v2\n']);

    // Meanwhile someone edited another paragraph: the proposal still merges.
    const { getNoteService } = await import('@/core/knowledge/notes');
    await getNoteService().save({ scope: aliceScope, id: n.id, title: n.title, body: 'INTRO\n\nbody\n', baseSha256: n.bodySha256 });

    const result = await acceptProposal(aliceScope, first.id);
    expect(result.status).toBe('accepted');
    if (result.status === 'accepted') expect(result.merged).toBe(true);
    expect(await bodyOf(n.id)).toBe('INTRO\n\nbody v2\n');
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw('SELECT origin, authors, on_behalf_of_user_id FROM note_revisions WHERE note_id = $1 ORDER BY created_at DESC, id LIMIT 1', [n.id]);
    expect(rows[0]).toMatchObject({ origin: 'proposal', on_behalf_of_user_id: bob });
    expect(rows[0].authors).toEqual([alice]);
    await expect(acceptProposal(aliceScope, first.id)).rejects.toThrow(/already accepted/);
  });

  test('a proposal whose change collides with a newer edit turns stale with the three-way view', async () => {
    const { proposeNoteEdit, acceptProposal } = await import('./edit-proposals');
    const n = await note('the cat sat\n');
    const proposal = await proposeNoteEdit(bobScope, { noteId: n.id, sessionId: randomUUID(), agentId: null, action: 'edit', baseBody: n.body, baseSha256: n.bodySha256, body: 'the bird sat\n' });
    const { getNoteService } = await import('@/core/knowledge/notes');
    await getNoteService().save({ scope: aliceScope, id: n.id, title: n.title, body: 'the dog sat\n', baseSha256: n.bodySha256 });

    const result = await acceptProposal(aliceScope, proposal.id);
    expect(result).toMatchObject({ status: 'stale', base: 'the cat sat\n', current: 'the dog sat\n', proposed: 'the bird sat\n' });
    expect(result.proposal.status).toBe('stale');
    // Nothing was reverted.
    expect(await bodyOf(n.id)).toBe('the dog sat\n');
  });

  test('reject closes a proposal; viewers decide nothing', async () => {
    const { proposeNoteEdit, acceptProposal, rejectProposal } = await import('./edit-proposals');
    const n = await note('keep\n');
    const proposal = await proposeNoteEdit(bobScope, { noteId: n.id, sessionId: randomUUID(), agentId: null, action: 'edit', baseBody: n.body, baseSha256: n.bodySha256, body: 'change\n' });
    await expect(acceptProposal(veraScope, proposal.id)).rejects.toThrow(/cannot write/);
    await expect(rejectProposal(veraScope, proposal.id)).rejects.toThrow(/cannot write/);
    const rejected = await rejectProposal(aliceScope, proposal.id);
    expect(rejected.status).toBe('rejected');
    expect(rejected.decidedBy).toBe(alice);
    expect(await bodyOf(n.id)).toBe('keep\n');
  });

  test('an archive proposal archives on accept', async () => {
    const { proposeNoteEdit, acceptProposal } = await import('./edit-proposals');
    const n = await note('old\n');
    const proposal = await proposeNoteEdit(bobScope, { noteId: n.id, sessionId: randomUUID(), agentId: null, action: 'archive', baseBody: n.body, baseSha256: n.bodySha256, body: n.body });
    expect((await acceptProposal(aliceScope, proposal.id)).status).toBe('accepted');
    const { getNoteService } = await import('@/core/knowledge/notes');
    expect((await getNoteService().getById(aliceScope, n.id))?.archivedAt).not.toBeNull();
  });

  test('a proposal names the base it was made from, and viewers cannot propose', async () => {
    const { proposeNoteEdit } = await import('./edit-proposals');
    const n = await note('x\n');
    await expect(proposeNoteEdit(bobScope, { noteId: n.id, sessionId: null, agentId: null, action: 'edit', baseBody: 'other', baseSha256: n.bodySha256, body: 'y\n' })).rejects.toThrow(/baseSha256/);
    await expect(proposeNoteEdit(veraScope, { noteId: n.id, sessionId: null, agentId: null, action: 'edit', baseBody: n.body, baseSha256: n.bodySha256, body: 'y\n' })).rejects.toThrow(/viewer/);
  });
});
