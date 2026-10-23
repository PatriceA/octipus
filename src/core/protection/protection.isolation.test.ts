/**
 * Protection levels (docs/PROTECTION-LEVELS.md): what content starts at,
 * who may change a level, and through which scope.
 *
 * What must hold: content without a level counts as 4; records start at
 * their type's default and documents at their source's; an agent raises but
 * never lowers or clears; a person may do both; the scope and the role
 * decide who reaches the content at all.
 *
 * Backed by ephemeral PGlite. The document queue is stubbed.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ContentRepos } from '@/db/repositories/content';

vi.mock('@/core/documents/queue', () => ({ getDocumentQueue: () => ({ enqueue: async () => undefined }) }));

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';
process.env.WORKSPACE_PATH ??= mkdtempSync(join(tmpdir(), 'octipus-protection-ws-'));

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const carol = '33333333-3333-4333-8333-333333333333';

let personal: (userId: string) => Promise<ContentRepos>;
let inSpace: (userId: string) => Promise<ContentRepos>;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-protection-db-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${alice}', 'alice', false), ('${bob}', 'bob', false), ('${carol}', 'carol', false) ON CONFLICT DO NOTHING`);
  const { spaceWith, resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
  const spaceId = await spaceWith(alice, [[bob, 'editor'], [carol, 'viewer']]);
  const { contentRepos } = await import('@/db/repositories/content');
  personal = async (userId) => contentRepos(await resolvedPrincipal(userId, null));
  inSpace = async (userId) => contentRepos(await resolvedPrincipal(userId, spaceId));
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('protection levels', () => {
  test('unclear counts as 4; records start at their type\'s default', async () => {
    const { effectiveProtectionLevel } = await import('@/shared/protection');
    const repos = await personal(alice);
    const c = await repos.cases.create({ title: 'Untitled matter' });
    expect([c.protectionLevel, effectiveProtectionLevel(c.protectionLevel)]).toEqual([null, 4]);
    const type = await repos.recordTypes.create({ key: 'invoice', name: 'Invoice', fields: [{ key: 'no', label: 'No', type: 'text' }], defaultProtectionLevel: 2 });
    const record = await repos.records.create(type.id, { data: { no: 'R-1' } });
    expect(record.protectionLevel).toBe(2);
    const own = await repos.records.create(type.id, { data: { no: 'R-2' }, protectionLevel: 3 });
    expect(own.protectionLevel).toBe(3);
    await expect(repos.recordTypes.create({ key: 'bad', name: 'Bad', fields: [], defaultProtectionLevel: 7 })).rejects.toThrow(/1, 2, 3 or 4/);
  });

  test('an agent raises, never lowers or clears; a person may do both', async () => {
    const { setProtectionLevel } = await import('./levels');
    const repos = await personal(alice);
    const c = await repos.cases.create({ title: 'Payroll question', protectionLevel: 2 });
    await expect(setProtectionLevel(repos, 'case', c.id, 1, 'agent')).rejects.toThrow(/Only a person can lower/);
    await expect(setProtectionLevel(repos, 'case', c.id, null, 'agent')).rejects.toThrow(/Only a person/);
    expect(await setProtectionLevel(repos, 'case', c.id, 4, 'agent')).toMatchObject({ from: 2, level: 4, effective: 4 });
    expect(await setProtectionLevel(repos, 'case', c.id, 1, 'person')).toMatchObject({ from: 4, level: 1, effective: 1 });
    expect(await setProtectionLevel(repos, 'case', c.id, null, 'person')).toMatchObject({ level: null, effective: 4 });
    await expect(setProtectionLevel(repos, 'case', c.id, 9, 'person')).rejects.toThrow(/1, 2, 3 or 4/);
    // Unclear content is already 4: an agent cannot set it lower either.
    const unclear = await repos.cases.create({ title: 'Unclear' });
    await expect(setProtectionLevel(repos, 'case', unclear.id, 3, 'agent')).rejects.toThrow(/it is 4/);
  });

  test('a record copies its type\'s default once; null is unclear, whoever set it', async () => {
    const { setProtectionLevel } = await import('./levels');
    const repos = await personal(alice);
    const type = await repos.recordTypes.findByKey('invoice');
    // A person asking for unclear at creation gets unclear, not the type's 2.
    const unclear = await repos.records.create(type!.id, { data: { no: 'R-3' }, protectionLevel: null });
    expect(unclear.protectionLevel).toBeNull();
    const record = await repos.records.create(type!.id, { data: { no: 'R-4' }, protectionLevel: 4 });
    expect(await setProtectionLevel(repos, 'record', record.id, null, 'person')).toMatchObject({ level: null, effective: 4 });
    // A later change of the type's default does not reach records made before.
    const copied = await repos.records.create(type!.id, { data: { no: 'R-5' } });
    await repos.recordTypes.update(type!.id, { defaultProtectionLevel: 1 });
    expect((await repos.records.findById(copied.id))?.protectionLevel).toBe(2);
  });

  test('an agent\'s raise never undoes a higher level set meanwhile', async () => {
    const repos = await personal(alice);
    const c = await repos.cases.create({ title: 'Race', protectionLevel: 2 });
    // The agent read 2 and asks for 3; a person set 4 in between: the conditional write refuses.
    await repos.cases.setProtectionLevel(c.id, 4);
    expect(await repos.cases.setProtectionLevel(c.id, 3, true)).toBeNull();
    expect((await repos.cases.findById(c.id))?.protectionLevel).toBe(4);
    // A plain case update never carries a level.
    await repos.cases.update(c.id, { title: 'Race (renamed)', protectionLevel: 1 } as never);
    expect((await repos.cases.findById(c.id))?.protectionLevel).toBe(4);
  });

  test('a reply quotes the original, so it starts at no lower level', async () => {
    const { replyProtectionLevel } = await import('@/core/mail/drafts');
    expect(replyProtectionLevel({ defaultProtectionLevel: 2 }, { protectionLevel: 4 })).toBe(4);
    expect(replyProtectionLevel({ defaultProtectionLevel: 3 }, { protectionLevel: 1 })).toBe(3);
    expect(replyProtectionLevel({ defaultProtectionLevel: 2 }, { protectionLevel: null })).toBe(4);
    expect(replyProtectionLevel({ defaultProtectionLevel: null }, { protectionLevel: 1 })).toBeNull();
  });

  test('documents start at their source\'s level and are set like the rest', async () => {
    const { ingestDocument } = await import('@/core/documents/ingest');
    const { setProtectionLevel } = await import('./levels');
    const repos = await personal(alice);
    const doc = await ingestDocument(repos, { buffer: Buffer.from('%PDF befund'), originalName: 'befund.pdf', protectionLevel: 4 });
    expect((await repos.documents.findById(doc.id))?.protectionLevel).toBe(4);
    expect(await setProtectionLevel(repos, 'document', doc.id, 3, 'person')).toMatchObject({ effective: 3 });
  });

  test('the scope and the role decide who reaches it', async () => {
    const { setProtectionLevel } = await import('./levels');
    const mine = await (await personal(alice)).cases.create({ title: 'Mine', protectionLevel: 3 });
    expect(await setProtectionLevel(await personal(bob), 'case', mine.id, 1, 'person')).toBeNull();
    // An admin's by-id access to another user's case does not reach its level.
    const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
    const { contentRepos } = await import('@/db/repositories/content');
    const adminRepos = contentRepos(await resolvedPrincipal(bob, null, { isAdmin: true }));
    expect(await setProtectionLevel(adminRepos, 'case', mine.id, 1, 'person')).toBeNull();
    const shared = await (await inSpace(alice)).cases.create({ title: 'Shared', protectionLevel: 3 });
    await expect(setProtectionLevel(await inSpace(carol), 'case', shared.id, 4, 'person')).rejects.toMatchObject({ name: 'SpaceError' });
    expect(await setProtectionLevel(await inSpace(bob), 'case', shared.id, 4, 'agent')).toMatchObject({ effective: 4 });
  });
});
