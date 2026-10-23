/**
 * Scan folders end to end (docs/SCAN-FOLDERS.md), and mail attachments filed
 * into documents: real directories, real files, documents written through
 * the folder's scope.
 *
 * What must hold: only admins set folders up, and never on the system or
 * Octipus's own data; settled regular files are filed once and moved aside,
 * while files still being written, hidden files and symbolic links are left
 * alone; a folder whose author can no longer write files nothing.
 *
 * Backed by ephemeral PGlite. The document queue is stubbed (no OCR runs).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
process.env.WORKSPACE_PATH ??= mkdtempSync(join(tmpdir(), 'octipus-scan-ws-'));

const admin = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';

let spaceId: string;
let personal: (userId: string, isAdmin?: boolean) => Promise<ContentRepos>;
let inSpace: (userId: string, isAdmin?: boolean) => Promise<ContentRepos>;

/**
 * A file the sweep sees as settled. Settling goes by the change time, which
 * no one can set back (`utimes` itself changes it), so the scans that should
 * file run with a clock past the settle time instead: `later()`.
 */
function settled(path: string, content: string): void {
  writeFileSync(path, content);
}
const later = () => new Date(Date.now() + 60_000);

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-scan-db-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${admin}', 'admin', true), ('${bob}', 'bob', false) ON CONFLICT DO NOTHING`);
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();
  const { spaceWith, resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
  spaceId = await spaceWith(bob, [[admin, 'editor']]);
  const { contentRepos } = await import('@/db/repositories/content');
  personal = async (userId, isAdmin = false) => contentRepos(await resolvedPrincipal(userId, null, { isAdmin }));
  inSpace = async (userId, isAdmin = false) => contentRepos(await resolvedPrincipal(userId, spaceId, { isAdmin }));
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('setting a scan folder up', () => {
  test('admins only', async () => {
    const repo = (await personal(bob)).scanFolders;
    expect(() => repo.assertManage()).toThrow(/Only an admin/);
    await expect(repo.create({ label: 'x', path: mkdtempSync(join(tmpdir(), 'scan-')), enabled: true })).rejects.toMatchObject({ name: 'SpaceError' });
  });

  test('never the system, Octipus\'s own data, a relative or a missing path; links are resolved', async () => {
    const { checkFolderPath } = await import('./paths');
    await expect(checkFolderPath('/etc')).rejects.toThrow(/system directory/);
    await expect(checkFolderPath('/')).rejects.toThrow(/root|system/);
    await expect(checkFolderPath('relative/dir')).rejects.toThrow(/absolute/);
    await expect(checkFolderPath('/nowhere/at/all')).rejects.toThrow(/does not exist/);
    await expect(checkFolderPath(process.env.WORKSPACE_PATH as string)).rejects.toThrow(/own data/);
    await expect(checkFolderPath(join(process.env.WORKSPACE_PATH as string, '..'))).rejects.toThrow(/own data|system/);
    const real = mkdtempSync(join(tmpdir(), 'scan-real-'));
    const link = `${real}-link`;
    symlinkSync(real, link);
    const { realpathSync } = await import('node:fs');
    expect(await checkFolderPath(link)).toBe(realpathSync(real));
    const hidden = mkdtempSync(join(tmpdir(), '.scan-hidden-'));
    await expect(checkFolderPath(hidden)).rejects.toThrow(/hidden/);
  });
});

describe('the sweep', () => {
  test('files settled regular files once, removes them, and leaves the rest alone', async () => {
    const { scanFolder } = await import('./sweep');
    const { checkFolderPath } = await import('./paths');
    const dir = mkdtempSync(join(tmpdir(), 'scan-drop-'));
    const repos = await personal(admin, true);
    const folder = await repos.scanFolders.create({ label: 'Scanner', path: await checkFolderPath(dir), enabled: true });

    settled(join(dir, 'rechnung.pdf'), '%PDF-1.4 one');
    settled(join(dir, 'upload.part'), 'still writing');
    settled(join(dir, '.hidden'), 'hidden');
    const outside = join(mkdtempSync(join(tmpdir(), 'scan-outside-')), 'secret.txt');
    settled(outside, 'not for the documents');
    symlinkSync(outside, join(dir, 'link.txt'));
    mkdirSync(join(dir, 'sub'));

    // Just written: nothing has settled yet.
    expect((await scanFolder(folder)).filed).toBe(0);
    // A file someone back-dates is still fresh: its change time says so.
    const past = new Date(Date.now() - 60 * 60_000);
    utimesSync(join(dir, 'rechnung.pdf'), past, past);
    expect((await scanFolder(folder)).filed).toBe(0);

    const first = await scanFolder(folder, later());
    expect([first.filed, first.failed, first.error]).toEqual([1, 0, undefined]);
    const docs = await repos.documents.listOwn(10);
    expect(docs.map((d) => [d.originalName, d.mimeType])).toEqual([['rechnung.pdf', 'application/pdf']]);
    expect(docs[0].metadata).toMatchObject({ source: 'scan_folder', scanFolderId: folder.id });
    // Filed and removed; nothing created in the folder; the rest untouched.
    expect(readdirSync(dir).sort()).toEqual(['.hidden', 'link.txt', 'sub', 'upload.part']);
    expect(existsSync(outside)).toBe(true);

    // The same content dropped again is removed, not filed twice; a new one is filed.
    settled(join(dir, 'rechnung.pdf'), '%PDF-1.4 one');
    settled(join(dir, 'brief.pdf'), '%PDF-1.4 two');
    const second = await scanFolder(folder, later());
    expect(second.filed).toBe(1);
    expect((await repos.documents.listOwn(10)).map((d) => d.originalName).sort()).toEqual(['brief.pdf', 'rechnung.pdf']);
    expect(existsSync(join(dir, 'rechnung.pdf'))).toBe(false);
  });

  test('a pipe, a hard link: refused without hanging, kept, and not tried again until changed', async () => {
    const { scanFolder } = await import('./sweep');
    const { checkFolderPath } = await import('./paths');
    const { execFileSync } = await import('node:child_process');
    const { linkSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'scan-odd-'));
    const repos = await personal(admin, true);
    const folder = await repos.scanFolders.create({ label: 'Odd', path: await checkFolderPath(dir), enabled: true });
    const outside = join(mkdtempSync(join(tmpdir(), 'scan-elsewhere-')), 'private.txt');
    settled(outside, 'someone else\'s file');
    linkSync(outside, join(dir, 'linked.txt'));
    execFileSync('mkfifo', [join(dir, 'pipe.pdf')]);

    const first = await scanFolder(folder, later());
    expect([first.filed, first.failed]).toEqual([0, 1]);
    expect(first.error).toMatch(/more than one link/);
    expect(existsSync(join(dir, 'linked.txt'))).toBe(true);
    expect((await repos.documents.listOwn(50)).some((d) => d.originalName === 'linked.txt')).toBe(false);
    // Remembered: the next tick does not try it again.
    expect((await scanFolder(folder, later())).failed).toBe(0);
  });

  test('a folder whose author is no longer an admin files nothing', async () => {
    const { scanFolder } = await import('./sweep');
    const { checkFolderPath } = await import('./paths');
    const { executeRaw } = await import('@/db/postgres');
    const dir = mkdtempSync(join(tmpdir(), 'scan-demoted-'));
    const folder = await (await personal(admin, true)).scanFolders.create({ label: 'D', path: await checkFolderPath(dir), enabled: true });
    settled(join(dir, 'a.pdf'), 'a');
    await executeRaw(`UPDATE users SET is_admin = false WHERE id = '${admin}'`);
    try {
      const result = await scanFolder(folder, later());
      expect([result.filed, result.error]).toEqual([0, 'The admin who set this folder up can no longer add documents here']);
      expect(existsSync(join(dir, 'a.pdf'))).toBe(true);
    } finally {
      await executeRaw(`UPDATE users SET is_admin = true WHERE id = '${admin}'`);
    }
  });

  test('a space folder files into the space; an author who can no longer write files nothing', async () => {
    const { scanFolder } = await import('./sweep');
    const { checkFolderPath } = await import('./paths');
    const dir = mkdtempSync(join(tmpdir(), 'scan-space-'));
    const repos = await inSpace(admin, true);
    const folder = await repos.scanFolders.create({ label: 'Fax', path: await checkFolderPath(dir), enabled: true });
    expect(folder.workspaceId).toBe(spaceId);
    settled(join(dir, 'fax.tif'), 'II*\u0000 fax');
    expect((await scanFolder(folder, later())).filed).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
    expect((await (await inSpace(bob)).documents.listOwn(10)).map((d) => d.originalName)).toEqual(['fax.tif']);

    // The admin becomes a viewer: the folder stops filing and says why.
    const { executeRaw } = await import('@/db/postgres');
    await executeRaw(`UPDATE workspace_members SET role = 'viewer' WHERE user_id = '${admin}' AND workspace_id = '${spaceId}'`);
    settled(join(dir, 'fax2.tif'), 'II*\u0000 fax two');
    const refused = await scanFolder(folder, later());
    expect([refused.filed, refused.error]).toEqual([0, 'The admin who set this folder up can no longer add documents here']);
    expect(existsSync(join(dir, 'fax2.tif'))).toBe(true);
    await executeRaw(`UPDATE workspace_members SET role = 'editor' WHERE user_id = '${admin}' AND workspace_id = '${spaceId}'`);
  });
});

describe('mail attachments into documents', () => {
  test('an account that files attachments puts them in its scope\'s documents', async () => {
    const dns = (await import('node:dns')).default;
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => [{ address: '93.184.216.34', family: 4 }]) as never);
    const { createMailAccount } = await import('@/core/mail/accounts');
    const { syncAccount } = await import('@/core/mail/sync');
    const repos = await personal(bob);
    const account = await createMailAccount(repos, {
      address: 'fax@example.com', incoming: { host: 'mail.example.com', port: 993, security: 'tls' }, fileAttachments: true,
    }, { incoming: 'pw' });
    const raw = Buffer.from([
      'From: fax@provider.de', 'To: fax@example.com', 'Subject: Fax from 0221 123', 'Message-ID: <fax1@provider.de>',
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '',
      '--b', 'Content-Type: text/plain', '', 'A fax for you.',
      '--b', 'Content-Type: application/pdf; name="fax.pdf"', 'Content-Disposition: attachment; filename="fax.pdf"', 'Content-Transfer-Encoding: base64', '',
      Buffer.from('%PDF-1.4 fax').toString('base64'), '--b--', '',
    ].join('\r\n'));
    const { getDb } = await import('@/db/postgres');
    const { mailAccounts } = await import('@/db/schema/mail');
    const { eq } = await import('drizzle-orm');
    const [row] = await getDb().select().from(mailAccounts).where(eq(mailAccounts.id, account.id));
    let served = false;
    const result = await syncAccount(row, {
      password: async () => 'pw',
      open: async () => ({
        async fetchNew(state) {
          const messages = served ? [] : [{ remoteId: '1:1', source: raw, truncated: false, size: raw.length, unread: true }];
          served = true;
          return { messages, state: { ...state, lastUid: 1 }, more: false };
        },
        async close() {},
        destroy() {},
      }),
    });
    expect(result).toEqual({ stored: 1, more: false });
    const docs = await repos.documents.listOwn(10);
    expect(docs.map((d) => d.originalName)).toEqual(['fax.pdf']);
    expect(docs[0].metadata).toMatchObject({ source: 'mail', mailAccountId: account.id, mailSubject: 'Fax from 0221 123' });
  });

  test('attachments that could not be filed are filed on a later sync, and the account says so meanwhile', async () => {
    const { createMailAccount } = await import('@/core/mail/accounts');
    const { syncAccount } = await import('@/core/mail/sync');
    const { getDb, executeRaw } = await import('@/db/postgres');
    const { mailAccounts, mailMessages } = await import('@/db/schema/mail');
    const { eq } = await import('drizzle-orm');
    const repos = await personal(bob);
    const account = await createMailAccount(repos, {
      address: 'fax2@example.com', incoming: { host: 'mail.example.com', port: 993, security: 'tls' }, fileAttachments: true,
    }, { incoming: 'pw' });
    const raw = Buffer.from([
      'From: fax@provider.de', 'Subject: Fax two', 'Message-ID: <fax2@provider.de>', 'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b"', '', '--b', 'Content-Type: text/plain', '', 'x',
      '--b', 'Content-Type: application/pdf; name="two.pdf"', 'Content-Disposition: attachment; filename="two.pdf"', 'Content-Transfer-Encoding: base64', '',
      Buffer.from('%PDF two').toString('base64'), '--b--', '',
    ].join('\r\n'));
    let served = false;
    const deps = {
      password: async () => 'pw',
      open: async () => ({
        async fetchNew(state: Record<string, unknown>) {
          const messages = served ? [] : [{ remoteId: '1:1', source: raw, truncated: false, size: raw.length, unread: true }];
          served = true;
          return { messages, state: { ...state, lastUid: 1 }, more: false };
        },
        async close() {},
        destroy() {},
      }),
    };
    const fresh = async () => (await getDb().select().from(mailAccounts).where(eq(mailAccounts.id, account.id)))[0];
    // The author is deactivated: the message is stored, its attachment waits.
    await executeRaw(`UPDATE users SET is_active = false WHERE id = '${bob}'`);
    expect((await syncAccount(await fresh(), deps)).stored).toBe(1);
    expect((await fresh()).lastError).toMatch(/could not be filed/);
    await executeRaw(`UPDATE users SET is_active = true WHERE id = '${bob}'`);
    await syncAccount(await fresh(), deps);
    expect((await repos.documents.listOwn(10)).map((d) => d.originalName)).toContain('two.pdf');
    const [message] = await getDb().select().from(mailMessages).where(eq(mailMessages.accountId, account.id));
    expect([message.filedAttachments, message.filingError]).toEqual([[0], null]);
    expect((await fresh()).lastError).toBeNull();
  });
});
