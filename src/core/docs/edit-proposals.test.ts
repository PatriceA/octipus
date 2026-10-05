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

  test('a decision is conditional on the proposal as it was read', async () => {
    const { proposeNoteEdit } = await import('./edit-proposals');
    const { decideProposal } = await import('@/db/repositories/live-documents');
    const n = await note('x\n');
    const session = randomUUID();
    const read = await proposeNoteEdit(bobScope, { noteId: n.id, sessionId: session, agentId: null, action: 'edit', baseBody: n.body, baseSha256: n.bodySha256, body: 'y\n' });
    // The agent updated it after the member read it: not decided.
    await proposeNoteEdit(bobScope, { noteId: n.id, sessionId: session, agentId: null, action: 'edit', baseBody: n.body, baseSha256: n.bodySha256, body: 'z\n' });
    expect(await decideProposal(spaceId, read.id, 'accepted', alice, read)).toBeNull();
    const now = await decideProposal(spaceId, read.id, 'rejected', alice, { ...read, body: 'z\n' });
    expect(now?.status).toBe('rejected');
  });

  test('an archive proposal of a note edited since turns stale and archives nothing', async () => {
    const { proposeNoteEdit, acceptProposal } = await import('./edit-proposals');
    const n = await note('old\n');
    const proposal = await proposeNoteEdit(bobScope, { noteId: n.id, sessionId: randomUUID(), agentId: null, action: 'archive', baseBody: n.body, baseSha256: n.bodySha256, body: n.body });
    const { getNoteService } = await import('@/core/knowledge/notes');
    await getNoteService().save({ scope: aliceScope, id: n.id, title: n.title, body: 'old, and much more since\n', baseSha256: n.bodySha256 });
    const result = await acceptProposal(aliceScope, proposal.id);
    expect(result).toMatchObject({ status: 'stale', base: 'old\n', current: 'old, and much more since\n' });
    expect((await getNoteService().getById(aliceScope, n.id))?.archivedAt).toBeNull();
  });

  test('accepting a closed note refreshes its tags and links', async () => {
    const { proposeNoteEdit, acceptProposal } = await import('./edit-proposals');
    const target = await note('the target\n');
    const n = await note('plain\n');
    const proposal = await proposeNoteEdit(bobScope, {
      noteId: n.id, sessionId: randomUUID(), agentId: null, action: 'edit', baseBody: n.body, baseSha256: n.bodySha256,
      body: `plain #proposed-tag [[${target.title}]]\n`,
    });
    expect((await acceptProposal(aliceScope, proposal.id)).status).toBe('accepted');
    const { getNoteService } = await import('@/core/knowledge/notes');
    expect((await getNoteService().getById(aliceScope, n.id))?.tags).toContain('proposed-tag');
    const backlinks = await getNoteService().backlinks(aliceScope, target.id);
    expect(backlinks.map((b) => b.fromId)).toContain(n.id);
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

  test('refusals are ToolNotExecutedError (nothing changed)', async () => {
    const { ToolNotExecutedError } = await import('@/core/tool-execution-error');
    const n = await note('x\n');
    const refusals = [
      run('write_note', { id: n.id, title: n.title, body: 'y\n' }),
      run('write_note', { id: n.id, title: n.title, body: 'y\n', base_sha256: 'f'.repeat(64) }),
      run('write_note', { id: n.id, title: n.title, body: 'y'.repeat(200_000), base_sha256: n.bodySha256 }),
      run('capture_note', { text: 'z'.repeat(200_000), date: '2026-05-01' }),
    ];
    for (const refused of refusals) expect(await refused.catch((e: unknown) => e)).toBeInstanceOf(ToolNotExecutedError);
    // The oversized capture of a day without a note created no note.
    const { getNoteService } = await import('@/core/knowledge/notes');
    expect(await getNoteService().getBySlug(aliceScope, 'daily/2026-05-01')).toBeNull();
    expect(await bodyOf(n.id)).toBe('x\n');
  });

  test('a pending proposal is rebased: a member\'s edit since is never reverted by the agent\'s next write', async () => {
    const n = await note('intro\n\nmiddle\n\nend\n');
    const read0 = await run('read_note', { id: n.id });
    const first = await run('write_note', { id: n.id, title: n.title, body: 'intro\n\nmiddle\n\nend E\n', base_sha256: read0.sha256 });
    // A member edits another paragraph.
    const { getNoteService } = await import('@/core/knowledge/notes');
    await getNoteService().save({ scope: aliceScope, id: n.id, title: n.title, body: 'INTRO\n\nmiddle\n\nend\n', baseSha256: n.bodySha256 });
    const read1 = await run('read_note', { id: n.id }) as { sha256: string; pendingProposal: { body: string; baseSha256: string; stale?: boolean } };
    expect(read1.sha256).not.toBe(read0.sha256);
    // Shown rebased onto the current text, with the current sha as its base.
    expect(read1.pendingProposal).toMatchObject({ body: 'INTRO\n\nmiddle\n\nend E\n', baseSha256: read1.sha256 });
    expect(read1.pendingProposal.stale).toBeUndefined();

    // The review's scenario: the agent extends the OLD proposal body and names the current sha.
    const second = await run('write_note', { id: n.id, title: n.title, body: 'intro\n\nmiddle F\n\nend E\n', base_sha256: read1.sha256 });
    expect(second.proposalId).toBe(first.proposalId);
    const { acceptProposal } = await import('./edit-proposals');
    expect((await acceptProposal(aliceScope, first.proposalId as string)).status).toBe('accepted');
    expect(await bodyOf(n.id)).toBe('INTRO\n\nmiddle F\n\nend E\n');

    // Editing from the rebased body works the same.
    const n2 = await note('a\n\nb\n');
    const r0 = await run('read_note', { id: n2.id });
    const p = await run('write_note', { id: n2.id, title: n2.title, body: 'a\n\nb B\n', base_sha256: r0.sha256 });
    await getNoteService().save({ scope: aliceScope, id: n2.id, title: n2.title, body: 'A\n\nb\n', baseSha256: n2.bodySha256 });
    const r1 = await run('read_note', { id: n2.id }) as { pendingProposal: { body: string; baseSha256: string } };
    await run('write_note', { id: n2.id, title: n2.title, body: `${r1.pendingProposal.body}c\n`, base_sha256: r1.pendingProposal.baseSha256 });
    expect((await acceptProposal(aliceScope, p.proposalId as string)).status).toBe('accepted');
    expect(await bodyOf(n2.id)).toBe('A\n\nb B\nc\n');
  });

  test('a pending proposal that collides with a member\'s edit is shown stale; a write from the current text replaces it', async () => {
    const { ToolNotExecutedError } = await import('@/core/tool-execution-error');
    const n = await note('the cat sat\n');
    const read0 = await run('read_note', { id: n.id });
    const first = await run('write_note', { id: n.id, title: n.title, body: 'the bird sat\n', base_sha256: read0.sha256 });
    const { getNoteService } = await import('@/core/knowledge/notes');
    await getNoteService().save({ scope: aliceScope, id: n.id, title: n.title, body: 'the dog sat\n', baseSha256: n.bodySha256 });
    const read1 = await run('read_note', { id: n.id }) as { sha256: string; pendingProposal: { body: string; baseSha256: string; stale?: boolean; hint: string } };
    expect(read1.pendingProposal).toMatchObject({ stale: true, body: 'the bird sat\n', baseSha256: read0.sha256 });
    expect(read1.pendingProposal.hint).toMatch(/replace it/);
    // Its old body over the new base would revert the member: refused.
    const refused = await run('write_note', { id: n.id, title: n.title, body: 'the bird sat down\n', base_sha256: read1.sha256 }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ToolNotExecutedError);
    expect((refused as Error).message).toMatch(/collides/);
    // From the current text: replaces it.
    await run('write_note', { id: n.id, title: n.title, body: 'the dog sat down\n', base_sha256: read1.sha256 });
    const { acceptProposal } = await import('./edit-proposals');
    expect((await acceptProposal(aliceScope, first.proposalId as string)).status).toBe('accepted');
    expect(await bodyOf(n.id)).toBe('the dog sat down\n');
  });

  test('concurrent captures of one session each add their line', async () => {
    const day = '2026-03-10';
    const { getNoteService } = await import('@/core/knowledge/notes');
    const daily = await getNoteService().capture(aliceScope, 'start', day);
    const results = await Promise.all(['one', 'two', 'three', 'four'].map((text) => run('capture_note', { text, date: day })));
    expect(new Set(results.map((r) => r.proposalId)).size).toBe(1);
    const { listNoteProposals } = await import('./edit-proposals');
    const [pending] = await listNoteProposals(aliceScope, { noteId: daily.id, status: 'pending' });
    for (const text of ['one', 'two', 'three', 'four']) expect(pending.body).toContain(` ${text}\n`);
  });

  test('two agents of one session (swarm children) proposing to one note keep both changes, or the second is refused', async () => {
    const { ToolNotExecutedError } = await import('@/core/tool-execution-error');
    const child = (id: string) => ({ ...agent, id }) as AgentContext;
    const as = (ctx: AgentContext, name: string, args: Record<string, unknown>) => tools.get(name)!.execute(args, ctx) as Promise<Record<string, unknown>>;
    const n = await note('one\n\ntwo\n\nthree\n');
    const [a, b] = await Promise.all([
      as(child('child-a'), 'write_note', { id: n.id, title: n.title, body: 'ONE\n\ntwo\n\nthree\n', base_sha256: n.bodySha256 }),
      as(child('child-b'), 'write_note', { id: n.id, title: n.title, body: 'one\n\ntwo\n\nTHREE\n', base_sha256: n.bodySha256 }),
    ]);
    expect(a.proposalId).toBe(b.proposalId);
    const { listNoteProposals } = await import('./edit-proposals');
    const [pending] = await listNoteProposals(aliceScope, { noteId: n.id, status: 'pending' });
    expect(pending.body).toBe('ONE\n\ntwo\n\nTHREE\n');
    // A change to the same text by the other child is refused, not swapped in.
    const clash = await as(child('child-c'), 'write_note', { id: n.id, title: n.title, body: 'one\n\ntwo\n\nthree!\n', base_sha256: n.bodySha256 }).catch((e: unknown) => e);
    expect(clash).toBeInstanceOf(ToolNotExecutedError);
    expect((await listNoteProposals(aliceScope, { noteId: n.id, status: 'pending' }))[0].body).toBe('ONE\n\ntwo\n\nTHREE\n');
  });

  test('an accept racing the agent\'s update never marks a body accepted that was not applied', async () => {
    const { acceptProposal } = await import('./edit-proposals');
    const { ToolNotExecutedError } = await import('@/core/tool-execution-error');
    for (let i = 0; i < 5; i++) {
      const n = await note('base\n');
      const first = await run('write_note', { id: n.id, title: n.title, body: 'base\nB1\n', base_sha256: n.bodySha256 });
      const [accepted, update] = await Promise.all([
        acceptProposal(aliceScope, first.proposalId as string),
        run('write_note', { id: n.id, title: n.title, body: 'base\nB2\n', base_sha256: n.bodySha256 }).catch((e: unknown) => e),
      ]);
      expect(accepted.status).toBe('accepted');
      // What was marked accepted is what the note says.
      expect(await bodyOf(n.id)).toBe(accepted.proposal.body);
      // The update went into the proposal before it was accepted, or came
      // after the accept: its base is gone (refused as not executed).
      if (update instanceof Error) {
        expect(update).toBeInstanceOf(ToolNotExecutedError);
        expect(accepted.proposal.body).toBe('base\nB1\n');
      } else {
        expect((update as Record<string, unknown>).proposalId).toBe(first.proposalId);
        expect(accepted.proposal.body).toBe('base\nB2\n');
      }
    }
  });

  test('archive and edits do not replace each other in one proposal', async () => {
    const { ToolNotExecutedError } = await import('@/core/tool-execution-error');
    const n = await note('text\n');
    await run('write_note', { id: n.id, title: n.title, body: 'text v2\n', base_sha256: n.bodySha256 });
    const archive = await run('archive_note', { id: n.id }).catch((e: unknown) => e);
    expect(archive).toBeInstanceOf(ToolNotExecutedError);
    expect((archive as Error).message).toMatch(/pending edit proposal/);

    const m = await note('gone\n');
    await run('archive_note', { id: m.id });
    const edit = await run('write_note', { id: m.id, title: m.title, body: 'kept\n', base_sha256: m.bodySha256 }).catch((e: unknown) => e);
    expect(edit).toBeInstanceOf(ToolNotExecutedError);
    expect((edit as Error).message).toMatch(/archive this note/);
    const { listNoteProposals } = await import('./edit-proposals');
    expect((await listNoteProposals(aliceScope, { noteId: m.id, status: 'pending' }))[0].action).toBe('archive');
  });

  test('a write that changes nothing proposes nothing; tags alone are not proposed', async () => {
    const n = await note('same\n');
    const before = heard.length;
    const same = await run('write_note', { id: n.id, title: n.title, body: 'same\n', base_sha256: n.bodySha256 });
    expect(same).toMatchObject({ unchanged: true, id: n.id });
    const tagsOnly = await run('write_note', { id: n.id, title: n.title, tags: ['x'] });
    expect(tagsOnly).toMatchObject({ unchanged: true });
    expect(tagsOnly.notice).toMatch(/tags/);
    const { listNoteProposals } = await import('./edit-proposals');
    expect(await listNoteProposals(aliceScope, { noteId: n.id })).toEqual([]);
    expect(heard.length).toBe(before);

    // A title-only write is proposed from the current text.
    const titled = await run('write_note', { id: n.id, title: 'New title' });
    expect(titled.proposed).toBe(true);
    expect((await listNoteProposals(aliceScope, { noteId: n.id, status: 'pending' }))[0]).toMatchObject({ title: 'New title', body: 'same\n' });
  });

  test('write_note by slug on an existing note proposes; a note a member creates meanwhile is not overwritten', async () => {
    const n = await note('by slug\n');
    const bySlug = await run('write_note', { slug: n.slug, title: n.title, body: 'by slug, changed\n', base_sha256: n.bodySha256 });
    expect(bySlug).toMatchObject({ proposed: true, id: n.id });
    expect(await bodyOf(n.id)).toBe('by slug\n');

    // The create-only write: a slug taken between the agent's lookup and its save is not written over.
    const { getNoteService, NoteExistsError } = await import('@/core/knowledge/notes');
    const taken = await note('member text\n');
    const refused = await getNoteService().save({ scope: bobScope, slug: taken.slug, title: 'Agent title', createOnly: true }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(NoteExistsError);
    expect((await getNoteService().getById(aliceScope, taken.id))?.title).toBe(taken.title);
    const day = '2026-03-11';
    await getNoteService().capture(aliceScope, 'member line', day);
    expect(await getNoteService().capture(bobScope, 'agent line', day, { createOnly: true }).catch((e: unknown) => e)).toBeInstanceOf(NoteExistsError);
    expect(await bodyOf((await getNoteService().getBySlug(aliceScope, `daily/${day}`))!.id)).not.toContain('agent line');
  });

  test('an agent working for a viewer proposes nothing', async () => {
    const { buildAgentContext } = await import('@/core/agent/context');
    const viewerAgent = buildAgentContext({
      sessionId: randomUUID(),
      userId: vera,
      scope: { workspaceId: spaceId, space: { workspaceId: spaceId, role: 'viewer', scope: null }, trigger: 'user', funding: 'own' },
      topic: 'general',
      model: 'test-model',
      role: 'general',
      root: true,
      status: 'running',
    });
    const n = await note('read only\n');
    await expect(tools.get('write_note')!.execute({ id: n.id, title: n.title, body: 'no\n', base_sha256: n.bodySha256 }, viewerAgent)).rejects.toThrow(/viewer/);
    await expect(tools.get('archive_note')!.execute({ id: n.id }, viewerAgent)).rejects.toThrow(/viewer/);
    const { listNoteProposals } = await import('./edit-proposals');
    expect(await listNoteProposals(aliceScope, { noteId: n.id })).toEqual([]);
  });

  test('on an open note, the base the hub handed out is the proposal\'s base', async () => {
    const { getDocHub } = await import('./index');
    const n = await note('open one\n\nopen two\n');
    const conn = { connectionId: `c-${rand(4)}`, userId: alice };
    await getDocHub().join(conn, n.id);
    try {
      const read = await run('read_note', { id: n.id });
      // A member types in the live document; the agent's base is now only in the hub.
      const { getNoteService } = await import('@/core/knowledge/notes');
      await getNoteService().save({ scope: aliceScope, id: n.id, title: n.title, body: 'OPEN ONE\n\nopen two\n', baseSha256: read.sha256 as string });
      const proposal = await run('write_note', { id: n.id, title: n.title, body: 'open one\n\nopen two, agent\n', base_sha256: read.sha256 });
      expect(proposal).toMatchObject({ proposed: true, baseSha256: read.sha256 });
      const { acceptProposal } = await import('./edit-proposals');
      expect((await acceptProposal(aliceScope, proposal.proposalId as string)).status).toBe('accepted');
      expect(await bodyOf(n.id)).toBe('OPEN ONE\n\nopen two, agent\n');
    } finally {
      await getDocHub().leave(conn.connectionId, n.id);
    }
  });

  test('meeting notes stay personal: refused in a space, nothing written or proposed', async () => {
    for (const [name, args] of [['write_meeting_note', { title: 'Standup in the space' }], ['import_calendar_meetings', {}]] as const) {
      await expect(run(name, args)).rejects.toThrow(/personal account and automation, so it is not available in a shared space/);
    }
    const { getNoteService } = await import('@/core/knowledge/notes');
    const notes = await getNoteService().list(aliceScope, { limit: 500 });
    expect(notes.some((n) => n.title === 'Standup in the space')).toBe(false);
  });

  test('doc.proposals reaches the connections that have the note open, through the gateway wiring', async () => {
    const { getGatewayHub } = await import('@/core/gateway/hub');
    const { wireDocumentHub } = await import('./index');
    const { setProposalChangeListener } = await import('./edit-proposals');
    const n = await note('watched\n');
    const sent = new Map<string, string[]>();
    const connections = (getGatewayHub().connectionManager as unknown as { connections: Map<string, unknown> }).connections;
    const fake = (id: string, resources: string[]) => {
      sent.set(id, []);
      connections.set(id, {
        ws: { readyState: 1, send: (raw: string) => sent.get(id)!.push(raw) },
        state: 'active',
        context: { connectionId: id, userId: alice, resources: new Set(resources) },
      });
    };
    fake('watching', [`doc:${n.id}`]);
    fake('elsewhere', ['doc:other']);
    wireDocumentHub();
    try {
      await run('write_note', { id: n.id, title: n.title, body: 'watched, changed\n', base_sha256: n.bodySha256 });
      expect(sent.get('watching')!.map((raw) => JSON.parse(raw))).toEqual([{ type: 'doc.proposals', noteId: n.id, spaceId, pending: 1 }]);
      expect(sent.get('elsewhere')).toEqual([]);
    } finally {
      connections.delete('watching');
      connections.delete('elsewhere');
      setProposalChangeListener((_ws, noteId, pending) => heard.push({ noteId, pending }));
    }
  });

  test('direct mode: read_note says writing no longer updates the pending proposal', async () => {
    const n = await note('before switch\n');
    await run('write_note', { id: n.id, title: n.title, body: 'proposed\n', base_sha256: n.bodySha256 });
    const { setAgentEditMode } = await import('@/core/spaces/service');
    await setAgentEditMode({ userId: alice }, spaceId, 'direct');
    try {
      const read = await run('read_note', { id: n.id }) as { pendingProposal: { hint: string } };
      expect(read.pendingProposal.hint).toMatch(/directly/);
      expect(read.pendingProposal.hint).not.toMatch(/to change the proposal/);
    } finally {
      await setAgentEditMode({ userId: alice }, spaceId, 'suggest');
    }
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
