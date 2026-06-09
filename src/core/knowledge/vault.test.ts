import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNoteFile, serializeNote, type VaultSync } from './vault';
import type { NoteService } from './notes';

describe('vault serialize/parse (pure)', () => {
  test('round-trips frontmatter + body', () => {
    const md = serializeNote({ title: 'My Note', slug: 'my-note', noteKind: 'note', noteDate: null, tags: ['a', 'b'], body: 'Hello [[World]]\n' });
    expect(md).toContain('title: My Note');
    expect(md).toContain('tags: [a, b]');
    const parsed = parseNoteFile(md, 'fallback');
    expect(parsed.title).toBe('My Note');
    expect(parsed.slug).toBe('my-note');
    expect(parsed.tags).toEqual(['a', 'b']);
    expect(parsed.body.trim()).toBe('Hello [[World]]');
  });

  test('falls back to the path slug when frontmatter is absent', () => {
    const parsed = parseNoteFile('# Just a body\n', 'daily/2026-06-09');
    expect(parsed.slug).toBe('daily/2026-06-09');
    expect(parsed.title).toBe('daily/2026-06-09');
    expect(parsed.noteKind).toBe('note');
  });
});

describe('VaultSync (embedded)', () => {
  const userId = randomUUID();
  const importer = randomUUID();
  let vault: VaultSync;
  let svc: NoteService;
  let dir: string;

  beforeAll(async () => {
    process.env.STORAGE_MODE = 'embedded';
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-vault-'));
    const { initializeDb } = await import('@/db/postgres');
    await initializeDb();
    const { runMigrations } = await import('@/db/migrate');
    await runMigrations();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: userId, username: 'vault-user' }, { id: importer, username: 'vault-importer' }]);
    vault = (await import('./vault')).getVaultSync();
    svc = (await import('./notes')).getNoteService();
  });

  afterAll(async () => {
    const { closeDb } = await import('@/db/postgres');
    await closeDb();
  });

  beforeEach(async () => {
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw('TRUNCATE TABLE notes');
    await executeRaw('TRUNCATE TABLE knowledge_links');
    dir = mkdtempSync(join(tmpdir(), 'octipus-vault-dir-'));
  });

  test('export writes a .md per note with frontmatter', async () => {
    await svc.save({ userId, title: 'Alpha', body: 'links [[Beta]]' });
    const res = await vault.exportVault(userId, dir);
    expect(res.exported).toBe(1);
    const content = readFileSync(join(dir, 'alpha.md'), 'utf8');
    expect(content).toContain('title: Alpha');
    expect(content).toContain('[[Beta]]');
  });

  test('import creates notes and re-links them', async () => {
    await writeFile(join(dir, 'imported.md'), '---\ntitle: Imported\nslug: imported\n---\nbody with [[Link]]\n');
    const res = await vault.importVault(importer, dir);
    expect(res.imported).toBe(1);
    const note = await svc.getBySlug(importer, null, 'imported');
    expect(note?.title).toBe('Imported');
  });

  test('import is idempotent (unchanged) and surfaces conflicts (DB authoritative)', async () => {
    // Seed a note in the DB.
    await svc.save({ userId, slug: 'doc', title: 'Doc', body: 'original body' });
    await vault.exportVault(userId, dir);

    // Re-import the exported file unchanged → no churn.
    const same = await vault.importVault(userId, dir);
    expect(same.unchanged).toBe(1);
    expect(same.imported).toBe(0);

    // Edit the file so it differs from the DB.
    await writeFile(join(dir, 'doc.md'), '---\ntitle: Doc\nslug: doc\n---\nEDITED in the vault\n');

    // Default: DB wins, conflict reported, DB unchanged.
    const conflict = await vault.importVault(userId, dir);
    expect(conflict.conflicts).toEqual(['doc']);
    expect((await svc.getBySlug(userId, null, 'doc'))?.body.trim()).toBe('original body');

    // force=true: the file wins.
    const forced = await vault.importVault(userId, dir, { force: true });
    expect(forced.updated).toBe(1);
    expect((await svc.getBySlug(userId, null, 'doc'))?.body.trim()).toBe('EDITED in the vault');
  });
});
