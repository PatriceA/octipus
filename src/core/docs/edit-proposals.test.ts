/**
 * Edit proposals (docs/plans/coworking-spec.md §7.4, §7.6 tests), service
 * level: one pending proposal per note and session, accepted through the
 * hub's merge when its base still merges, else `stale` with the three-way
 * view; rejected; decided only by members who may write. And end to end
 * through the notes tool: in `suggest` mode an agent's write, capture and
 * archive in a space become the session's pending proposal (shown by
 * `read_note`), accepting applies it, a changed base makes it stale; in
 * `direct` mode the agent writes the note.
 *
 * Backed by ephemeral PGlite; no embedding model (indexing degrades, logged).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ToolHandler } from '@/core/agent-base';
import type { AgentContext } from '@/core/types';
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
let spaceId: string;

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
  spaceId = await spaceWith(alice, [[bob, 'editor'], [vera, 'viewer']]);
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

describe('through the notes tool', () => {
  let tools: Map<string, ToolHandler>;
  let agent: AgentContext;
  const heard: Array<{ noteId: string; pending: number }> = [];
  const run = (name: string, args: Record<string, unknown>) => tools.get(name)!.execute(args, agent) as Promise<Record<string, unknown>>;

  beforeAll(async () => {
    // No embedding model: indexing degrades (logged) without reaching a network.
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    vi.spyOn(getEmbeddingService(), 'generateEmbedding').mockRejectedValue(new Error('No embedding model configured (test)'));
    vi.spyOn(getEmbeddingService(), 'embedBatch').mockImplementation(async (texts: string[]) => texts.map(() => new Error('No embedding model configured (test)')));
    const { NotesTool } = await import('@/tools/notes');
    const tool = new NotesTool();
    await tool.initialize();
    tools = (tool as unknown as { tools: Map<string, ToolHandler> }).tools;
    const { buildAgentContext } = await import('@/core/agent/context');
    agent = buildAgentContext({
      sessionId: randomUUID(),
      userId: bob,
      scope: { workspaceId: spaceId, space: { workspaceId: spaceId, role: 'editor', scope: null }, trigger: 'user', funding: 'own' },
      topic: 'general',
      model: 'test-model',
      role: 'general',
      root: true,
      status: 'running',
    });
    const { setProposalChangeListener } = await import('./edit-proposals');
    setProposalChangeListener((_ws, noteId, pending) => heard.push({ noteId, pending }));
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  test('suggest (the default): write_note on an existing note proposes; read_note shows it; accept applies it', async () => {
    const n = await note('intro\n\nbody\n');
    const read = await run('read_note', { id: n.id });
    expect(read.pendingProposal).toBeUndefined();
    const first = await run('write_note', { id: n.id, title: n.title, body: 'intro\n\nbody v1\n', base_sha256: read.sha256 });
    expect(first).toMatchObject({ proposed: true, status: 'pending', baseSha256: read.sha256, id: n.id });
    expect(heard.at(-1)).toEqual({ noteId: n.id, pending: 1 });
    // The note is unchanged; the agent sees its proposal beside it.
    expect(await bodyOf(n.id)).toBe('intro\n\nbody\n');
    const again = await run('read_note', { id: n.id });
    expect(again.body).toBe('intro\n\nbody\n');
    expect(again.pendingProposal).toMatchObject({ proposalId: first.proposalId, status: 'pending', action: 'edit', body: 'intro\n\nbody v1\n', baseSha256: read.sha256 });

    // A second write updates the same proposal; a new title is proposed too.
    const second = await run('write_note', { id: n.id, title: 'Renamed', body: 'intro\n\nbody v2\n', base_sha256: read.sha256 });
    expect(second.proposalId).toBe(first.proposalId);

    const { acceptProposal } = await import('./edit-proposals');
    const accepted = await acceptProposal(aliceScope, first.proposalId as string);
    expect(accepted.status).toBe('accepted');
    expect(heard.at(-1)).toEqual({ noteId: n.id, pending: 0 });
    expect(await bodyOf(n.id)).toBe('intro\n\nbody v2\n');
    const { getNoteService } = await import('@/core/knowledge/notes');
    expect((await getNoteService().getById(aliceScope, n.id))?.title).toBe('Renamed');
    expect((await run('read_note', { id: n.id })).pendingProposal).toBeUndefined();
  });

  test('a proposal whose base changed in the same place goes stale on accept; nothing is reverted', async () => {
    const n = await note('the cat sat\n');
    const read = await run('read_note', { id: n.id });
    const proposal = await run('write_note', { id: n.id, title: n.title, body: 'the bird sat\n', base_sha256: read.sha256 });
    const { getNoteService } = await import('@/core/knowledge/notes');
    await getNoteService().save({ scope: aliceScope, id: n.id, title: n.title, body: 'the dog sat\n', baseSha256: n.bodySha256 });
    const { acceptProposal } = await import('./edit-proposals');
    const result = await acceptProposal(aliceScope, proposal.proposalId as string);
    expect(result).toMatchObject({ status: 'stale', base: 'the cat sat\n', current: 'the dog sat\n', proposed: 'the bird sat\n' });
    expect(await bodyOf(n.id)).toBe('the dog sat\n');
  });

  test('a body change needs the base it was made from; an unknown base is refused', async () => {
    const n = await note('x\n');
    await expect(run('write_note', { id: n.id, title: n.title, body: 'y\n' })).rejects.toThrow(/sha256 of the text/);
    await expect(run('write_note', { id: n.id, title: n.title, body: 'y\n', base_sha256: 'f'.repeat(64) })).rejects.toThrow(/changed since it was read/);
  });

  test('a new note is created, not proposed', async () => {
    const created = await run('write_note', { title: `Fresh ${rand(4)}`, body: 'new\n' });
    expect(created.proposed).toBeUndefined();
    expect(created.created).toBe(true);
    expect(await bodyOf(created.id as string)).toBe('new\n');
  });

  test('capture into an existing daily note is proposed, and captures accumulate in one proposal', async () => {
    const day = '2026-03-04';
    const { getNoteService } = await import('@/core/knowledge/notes');
    const daily = await getNoteService().capture(aliceScope, 'alice was here', day);
    const one = await run('capture_note', { text: 'first idea', date: day });
    const two = await run('capture_note', { text: 'second idea', date: day });
    expect(one).toMatchObject({ proposed: true, status: 'pending', id: daily.id });
    expect(two.proposalId).toBe(one.proposalId);
    expect(await bodyOf(daily.id)).not.toContain('idea');
    const { acceptProposal } = await import('./edit-proposals');
    expect((await acceptProposal(aliceScope, one.proposalId as string)).status).toBe('accepted');
    const body = await bodyOf(daily.id);
    expect(body).toContain('alice was here');
    expect(body.indexOf('first idea')).toBeLessThan(body.indexOf('second idea'));

    // A day with no note yet: the capture creates it.
    const fresh = await run('capture_note', { text: 'a new day', date: '2026-03-05' });
    expect(fresh).toMatchObject({ captured: true });
    expect(await bodyOf(fresh.id as string)).toContain('a new day');
  });

  test('archive is proposed; accepting archives', async () => {
    const n = await note('old\n');
    const proposal = await run('archive_note', { id: n.id });
    expect(proposal).toMatchObject({ proposed: true, status: 'pending' });
    const { getNoteService } = await import('@/core/knowledge/notes');
    expect((await getNoteService().getById(aliceScope, n.id))?.archivedAt).toBeNull();
    const { acceptProposal } = await import('./edit-proposals');
    expect((await acceptProposal(aliceScope, proposal.proposalId as string)).status).toBe('accepted');
    expect((await getNoteService().getById(aliceScope, n.id))?.archivedAt).not.toBeNull();
  });

  test('direct mode: the agent writes the note through the hub, no proposal', async () => {
    const { setAgentEditMode } = await import('@/core/spaces/service');
    await setAgentEditMode({ userId: alice }, spaceId, 'direct');
    try {
      const n = await note('one\n');
      const read = await run('read_note', { id: n.id });
      const written = await run('write_note', { id: n.id, title: n.title, body: 'two\n', base_sha256: read.sha256 });
      expect(written.proposed).toBeUndefined();
      expect(written.created).toBe(false);
      expect(await bodyOf(n.id)).toBe('two\n');
      const { listNoteProposals } = await import('./edit-proposals');
      expect(await listNoteProposals(aliceScope, { noteId: n.id })).toEqual([]);
      expect((await run('archive_note', { id: n.id })).archived).toBe(true);
    } finally {
      await setAgentEditMode({ userId: alice }, spaceId, 'suggest');
    }
  });
});
