/**
 * Mail accounts end to end (docs/MAIL.md): who reaches which mailbox, which
 * hosts an account may use, the sync storing received mail once, a real
 * POP3 drop synced over TCP, and drafts sent over a real SMTP server.
 *
 * What must hold: a personal mailbox is its owner's alone (no admin read
 * either); a space's functional mailbox is read by members, written from by
 * editors, set up by owners, and reached by no guest; a host on the local
 * network needs an admin and plaintext is only for the local network; a
 * message is stored once however often it is fetched; a draft goes out
 * once, and a failed send can be sent again.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes } from 'node:crypto';
import dns from 'node:dns';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ContentRepos } from '@/db/repositories/content';
import type { MailAccount } from '@/db/schema/mail';
import { startFakePop3 } from './fixtures/fake-pop3';
import type { FetchedMessage, MailSource } from './sources';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const carol = '33333333-3333-4333-8333-333333333333';
const dave = '44444444-4444-4444-8444-444444444444';
const erin = '55555555-5555-4555-8555-555555555555';
const admin = '66666666-6666-4666-8666-666666666666';

const PUBLIC = { host: 'mail.example.com', port: 993, security: 'tls' as const };

let spaceId: string;
let personal: (userId: string, isAdmin?: boolean) => Promise<ContentRepos>;
let inSpace: (userId: string) => Promise<ContentRepos>;

function raw(opts: { id: string; subject: string; from?: string; date?: string; body?: string }): string {
  return [
    `From: ${opts.from ?? 'Max <max@client.de>'}`,
    'To: info@praxis.de',
    `Subject: ${opts.subject}`,
    `Message-ID: <${opts.id}@client.de>`,
    `Date: ${opts.date ?? new Date().toUTCString()}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    opts.body ?? `Body of ${opts.subject}`,
    '',
  ].join('\r\n');
}

function fetched(remoteId: string, id: string, subject: string): FetchedMessage {
  const source = Buffer.from(raw({ id, subject }));
  return { remoteId, source, truncated: false, size: source.length, unread: true };
}

/** A source handing out `batches` in turn, then nothing. */
function fakeSource(batches: FetchedMessage[][]): MailSource {
  let i = 0;
  return {
    async fetchNew(state) {
      const messages = batches[i] ?? [];
      i++;
      return { messages, state: { ...state, lastUid: (state.lastUid ?? 0) + messages.length }, more: i < batches.length };
    },
    async close() {},
    destroy() {},
  };
}

async function freshAccount(id: string): Promise<MailAccount> {
  const { getDb } = await import('@/db/postgres');
  const { mailAccounts } = await import('@/db/schema/mail');
  const { eq } = await import('drizzle-orm');
  const [row] = await getDb().select().from(mailAccounts).where(eq(mailAccounts.id, id));
  return row;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-mail-'));
  // Name resolution without the network: one public host, one on the local network.
  const lookup = dns.promises.lookup;
  vi.spyOn(dns.promises, 'lookup').mockImplementation((async (host: string, opts: unknown) => {
    if (host === 'mail.example.com') return [{ address: '93.184.216.34', family: 4 }];
    if (host === 'kim.lan') return [{ address: '10.0.0.5', family: 4 }];
    if (host === 'smtp.example.com') return [{ address: '93.184.216.35', family: 4 }];
    return (lookup as (h: string, o: unknown) => Promise<unknown>)(host, opts);
  }) as never);
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(
    `INSERT INTO users (id, username, is_admin) VALUES
       ('${alice}', 'alice', false), ('${bob}', 'bob', false), ('${carol}', 'carol', false),
       ('${dave}', 'dave', false), ('${erin}', 'erin', false), ('${admin}', 'admin', true)
     ON CONFLICT DO NOTHING`,
  );
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();
  const { spaceWith, resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
  // alice owns; bob edits; carol views; dave is a guest.
  spaceId = await spaceWith(alice, [[bob, 'editor'], [carol, 'viewer'], [dave, 'guest']]);
  const { contentRepos } = await import('@/db/repositories/content');
  personal = async (userId, isAdmin = false) => contentRepos(await resolvedPrincipal(userId, null, { isAdmin }));
  inSpace = async (userId) => contentRepos(await resolvedPrincipal(userId, spaceId));
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('who reaches a mailbox', () => {
  test('a personal mailbox is its owner\'s alone, an admin\'s reads included', async () => {
    const { createMailAccount, accountViews } = await import('./accounts');
    const a = await personal(alice);
    const account = await createMailAccount(a, { address: 'alice@example.com', incoming: PUBLIC }, { incoming: 'pw-alice' });
    const [view] = await accountViews([account]);
    expect(view.passwordSet).toEqual({ incoming: true, outgoing: false });
    expect(JSON.stringify(view)).not.toContain('pw-alice');

    for (const other of [await personal(erin), await personal(admin, true)]) {
      expect(await other.mail.account(account.id)).toBeNull();
      expect((await other.mail.accounts()).map((r) => r.id)).not.toContain(account.id);
      expect(await other.mail.updateAccount(account.id, { label: 'stolen' })).toBeNull();
      expect(await other.mail.deleteAccount(account.id)).toBe(false);
    }
    expect((await a.mail.account(account.id))?.label).toBe('alice@example.com');
  });

  test('a functional mailbox: owners set it up, members read, editors write, guests see nothing', async () => {
    const { createMailAccount } = await import('./accounts');
    await expect(createMailAccount(await inSpace(bob), { address: 'info@praxis.de', incoming: PUBLIC })).rejects.toMatchObject({ name: 'SpaceError' });
    const account = await createMailAccount(await inSpace(alice), { label: 'Info', address: 'info@praxis.de', incoming: PUBLIC }, { incoming: 'pw' });
    expect(account.workspaceId).toBe(spaceId);

    const viewer = await inSpace(carol);
    expect((await viewer.mail.accounts()).map((r) => r.id)).toContain(account.id);
    await expect(viewer.mail.createDraft(account, { toAddresses: [{ address: 'x@y.de' }], ccAddresses: [], subject: 's', bodyText: 'b' })).rejects.toMatchObject({ name: 'SpaceError' });

    const editor = await inSpace(bob);
    const draft = await editor.mail.createDraft(account, { toAddresses: [{ address: 'x@y.de' }], ccAddresses: [], subject: 'Hello', bodyText: 'Text' });
    expect([draft.status, draft.workspaceId, draft.authorId]).toEqual(['draft', spaceId, bob]);
    expect((await viewer.mail.message(draft.id))?.subject).toBe('Hello');

    const guest = await inSpace(dave);
    expect(await guest.mail.accounts()).toEqual([]);
    expect(await guest.mail.message(draft.id)).toBeNull();
    // A personal scope never reaches the space's mailbox.
    expect(await (await personal(alice)).mail.account(account.id)).toBeNull();
  });
});

describe('which hosts an account may use', () => {
  test('the local network needs an admin; plaintext only there', async () => {
    const { createMailAccount, updateMailAccount } = await import('./accounts');
    const a = await personal(alice);
    await expect(createMailAccount(a, { address: 'kim@praxis.de', incoming: { host: 'kim.lan', port: 995, security: 'tls' } })).rejects.toThrow(/only an admin/);
    await expect(createMailAccount(a, { address: 'a@example.com', incoming: { ...PUBLIC, security: 'none' } })).rejects.toThrow(/unencrypted/i);
    await expect(createMailAccount(a, { address: 'a@example.com', incoming: { host: '127.0.0.1', port: 110, security: 'none' } })).rejects.toThrow(/only an admin/);

    const adm = await personal(admin, true);
    const kim = await createMailAccount(adm, { address: 'kim@praxis.de', protocol: 'pop3', incoming: { host: 'kim.lan', port: 110, security: 'none' } });
    expect(kim.localNetwork).toBe(true);
    // Moved to a public host, the allowance goes.
    const moved = await updateMailAccount(adm, kim.id, { incoming: PUBLIC });
    expect(moved?.localNetwork).toBe(false);
    expect(moved?.syncState).toEqual({});
  });

  test('the role is checked before any host is resolved', async () => {
    const { createMailAccount } = await import('./accounts');
    // An editor learns nothing about the host (resolvable or not): the refusal is the role's.
    await expect(createMailAccount(await inSpace(bob), { address: 'x@praxis.de', incoming: { host: 'kim.lan', port: 995, security: 'tls' } }))
      .rejects.toMatchObject({ name: 'SpaceError' });
  });

  test('a server moved to another host forgets its password; outgoing borrows the incoming one only on the same host', async () => {
    const { createMailAccount, updateMailAccount, accountViews } = await import('./accounts');
    const { outgoingPassword } = await import('./secrets');
    const a = await personal(alice);
    const account = await createMailAccount(a, {
      address: 'move@example.com', incoming: PUBLIC, outgoing: { host: 'mail.example.com', port: 465, security: 'tls' },
    }, { incoming: 'in-pw' });
    expect(await outgoingPassword(account)).toBe('in-pw');

    const relabeled = await updateMailAccount(a, account.id, { label: 'Renamed' });
    expect((await accountViews([relabeled!]))[0].passwordSet.incoming).toBe(true);

    // The outgoing server elsewhere: the incoming password is not handed to it.
    const split = await updateMailAccount(a, account.id, { outgoing: { host: 'smtp.example.com', port: 465, security: 'tls' } });
    expect(await outgoingPassword(split!)).toBeNull();
    // The incoming server elsewhere: its password is gone, unless a new one comes along.
    const movedIn = await updateMailAccount(a, account.id, { incoming: { ...PUBLIC, host: 'smtp.example.com' } });
    expect((await accountViews([movedIn!]))[0].passwordSet.incoming).toBe(false);
    const withNew = await updateMailAccount(a, account.id, { incoming: PUBLIC }, { incoming: 'new-pw' });
    expect((await accountViews([withNew!]))[0].passwordSet.incoming).toBe(true);
  });
});

describe('sync', () => {
  test('stores each message once, in the account\'s scope, and moves the state on', async () => {
    const { createMailAccount } = await import('./accounts');
    const { syncAccount } = await import('./sync');
    const owner = await inSpace(alice);
    const account = await createMailAccount(owner, { address: 'sync@praxis.de', incoming: PUBLIC }, { incoming: 'pw' });
    const first = await syncAccount(await freshAccount(account.id), {
      password: async () => 'pw',
      open: async () => fakeSource([[fetched('1:1', 'a', 'First'), fetched('1:2', 'b', 'Second')], [fetched('1:3', 'c', 'Third')]]),
    });
    expect(first).toEqual({ stored: 3, more: false });
    // The same messages again (another remote id after a UIDVALIDITY reset): stored once.
    const again = await syncAccount(await freshAccount(account.id), {
      password: async () => 'pw',
      open: async () => fakeSource([[fetched('1:1', 'a', 'First'), fetched('2:9', 'b', 'Second')]]),
    });
    expect(again.stored).toBe(0);
    const rows = await (await inSpace(carol)).mail.list({ accountId: account.id });
    expect(rows.map((r) => r.subject).sort()).toEqual(['First', 'Second', 'Third']);
    expect(rows.every((r) => r.workspaceId === spaceId && r.status === 'received' && r.unread)).toBe(true);
    // The state is the source's, saved after each batch (the fake counts what it handed out).
    expect((await freshAccount(account.id)).syncState.lastUid).toBe(5);
    expect(await (await inSpace(carol)).mail.raw(rows[0].id)).toBeInstanceOf(Buffer);
  });

  test('a message with a NUL byte is stored, and the mailbox keeps syncing', async () => {
    const { createMailAccount } = await import('./accounts');
    const { syncAccount } = await import('./sync');
    const account = await createMailAccount(await personal(alice), { address: 'nul@example.com', incoming: PUBLIC }, { incoming: 'pw' });
    const bad = Buffer.from('From: x@y.de\r\nSubject: =?utf-8?B?aGkA?=\r\nMessage-ID: <nul@y.de>\r\n\r\nbody\u0000end\r\n');
    const result = await syncAccount(await freshAccount(account.id), {
      password: async () => 'pw',
      open: async () => fakeSource([[{ remoteId: '1:1', source: bad, truncated: false, size: bad.length, unread: true }, fetched('1:2', 'after', 'After')]]),
    });
    expect(result).toEqual({ stored: 2, more: false });
    const subjects = (await (await personal(alice)).mail.list({ accountId: account.id })).map((r) => r.subject).sort();
    expect(subjects).toEqual(['After', 'hi']);
  });

  test('a sync does not write an old server\'s state over a change made meanwhile', async () => {
    const { createMailAccount, updateMailAccount } = await import('./accounts');
    const { syncAccount } = await import('./sync');
    const a = await personal(alice);
    const account = await createMailAccount(a, { address: 'race@example.com', incoming: PUBLIC }, { incoming: 'pw' });
    const source = fakeSource([[fetched('1:1', 'r1', 'R1')]]);
    const fetchNew = source.fetchNew.bind(source);
    source.fetchNew = async (state, opts) => {
      await updateMailAccount(a, account.id, { incoming: { ...PUBLIC, port: 143, security: 'starttls' } });
      return fetchNew(state, opts);
    };
    await syncAccount(await freshAccount(account.id), { password: async () => 'pw', open: async () => source });
    expect((await freshAccount(account.id)).syncState).toEqual({});
  });

  test('a send cut off midway is marked failed, saying it may have gone out; orphaned passwords are removed', async () => {
    const { reapStuckSends } = await import('./sync');
    const { pruneOrphanMailPasswords, setMailPassword, mailPassword } = await import('./secrets');
    const { createMailAccount } = await import('./accounts');
    const { getDb } = await import('@/db/postgres');
    const { mailMessages } = await import('@/db/schema/mail');
    const { eq } = await import('drizzle-orm');
    const a = await personal(alice);
    const account = await createMailAccount(a, { address: 'stuck@example.com', incoming: PUBLIC, outgoing: { ...PUBLIC, port: 465 } }, { incoming: 'pw' });
    const draft = await a.mail.createDraft(account, { toAddresses: [{ address: 'x@y.de' }], ccAddresses: [], subject: 's', bodyText: 'b' });
    await a.mail.claimForSend(draft.id);
    await getDb().update(mailMessages).set({ updatedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(mailMessages.id, draft.id));
    expect(await reapStuckSends()).toBeGreaterThanOrEqual(1);
    const reaped = await a.mail.message(draft.id);
    expect(reaped?.status).toBe('failed');
    expect(reaped?.error).toMatch(/may have gone out/);

    const gone = '99999999-9999-4999-8999-999999999999';
    await setMailPassword(gone, 'incoming', 'left-behind');
    expect(await pruneOrphanMailPasswords()).toBeGreaterThanOrEqual(1);
    expect(await mailPassword(gone, 'incoming')).toBeNull();
    expect(await mailPassword(account.id, 'incoming')).toBe('pw');
  });

  test('a failure is recorded and spaces the next attempt out', async () => {
    const { createMailAccount } = await import('./accounts');
    const { syncAccount, syncDueMailAccounts } = await import('./sync');
    const account = await createMailAccount(await personal(erin), { address: 'erin@example.com', incoming: PUBLIC }, { incoming: 'pw' });
    const t0 = new Date();
    const broken = { password: async () => 'pw', open: async () => { throw Object.assign(new Error('nope'), { authenticationFailed: true }); } };
    const result = await syncAccount(await freshAccount(account.id), broken, t0);
    expect(result.error).toBe('The server refused the login');
    const after = await freshAccount(account.id);
    expect([after.failures, after.lastError]).toEqual([1, 'The server refused the login']);

    // Due after twice the interval, not before. Count only this account's opens.
    const opened: string[] = [];
    const counting = { password: async () => 'pw', open: async (a: MailAccount) => { opened.push(a.id); return fakeSource([]); } };
    await syncDueMailAccounts(new Date(t0.getTime() + 6 * 60_000), counting);
    expect(opened).not.toContain(account.id);
    await syncDueMailAccounts(new Date(t0.getTime() + 11 * 60_000), counting);
    expect(opened).toContain(account.id);
    expect((await freshAccount(account.id)).failures).toBe(0);
  });

  test('two syncs of one account do not run at once', async () => {
    const { createMailAccount } = await import('./accounts');
    const { syncAccount } = await import('./sync');
    const account = await createMailAccount(await personal(bob), { address: 'bob@example.com', incoming: PUBLIC }, { incoming: 'pw' });
    const row = await freshAccount(account.id);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = { password: async () => 'pw', open: async () => { await gate; return fakeSource([]); } };
    const first = syncAccount(row, slow);
    const second = await syncAccount(row, slow);
    expect(second.error).toMatch(/already running/);
    release();
    expect((await first).error).toBeUndefined();
  });
});

describe('POP3 and SMTP for real', () => {
  let kim: MailAccount;
  let pop: Awaited<ReturnType<typeof startFakePop3>>;
  const received: Array<{ from: string; to: string[]; data: string }> = [];
  let smtp: SMTPServer;
  let smtpPort: number;

  beforeAll(async () => {
    pop = await startFakePop3({
      user: 'kim', pass: 'pop-pw',
      messages: [
        { uid: 'old', raw: raw({ id: 'old', subject: 'Last year', date: 'Mon, 06 Jan 2025 10:00:00 +0000' }) },
        { uid: 'u1', raw: raw({ id: 'u1', subject: 'Befund', from: 'Labor <labor@kim.telematik>' }) },
        { uid: 'u2', raw: raw({ id: 'u2', subject: 'eAU' }) },
        // The same message delivered twice (an alias): another UIDL, the same Message-ID.
        { uid: 'u2-copy', raw: raw({ id: 'u2', subject: 'eAU' }) },
      ],
    });
    smtp = new SMTPServer({
      secure: false,
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,
      logger: false,
      onAuth(auth, _session, cb) {
        if (auth.username === 'kim' && auth.password === 'smtp-pw') cb(null, { user: 'kim' });
        else cb(new Error('Invalid login'));
      },
      onData(stream, session, cb) {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          received.push({ from: String(session.envelope.mailFrom && session.envelope.mailFrom.address), to: session.envelope.rcptTo.map((r) => r.address), data: Buffer.concat(chunks).toString() });
          cb();
        });
      },
    });
    await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
    smtpPort = (smtp.server.address() as { port: number }).port;

    const { createMailAccount } = await import('./accounts');
    kim = await createMailAccount(await personal(admin, true), {
      label: 'KIM',
      address: 'praxis@kim.telematik',
      displayName: 'Praxis Dr. Test',
      protocol: 'pop3',
      incoming: { host: '127.0.0.1', port: pop.port, security: 'none', username: 'kim' },
      outgoing: { host: '127.0.0.1', port: smtpPort, security: 'none', username: 'kim' },
    }, { incoming: 'pop-pw', outgoing: 'smtp-pw' });
  });

  afterAll(async () => {
    await pop.close();
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
  });

  test('a first POP3 sync takes the window only; later syncs take what is new; nothing twice', async () => {
    const { syncAccount } = await import('./sync');
    expect(await syncAccount(await freshAccount(kim.id))).toEqual({ stored: 2, more: false });
    expect(pop.retrieved.sort()).toEqual(['u1', 'u2', 'u2-copy']);
    pop.messages.push({ uid: 'u3', raw: raw({ id: 'u3', subject: 'Neu' }) });
    expect(await syncAccount(await freshAccount(kim.id))).toEqual({ stored: 1, more: false });
    // Nothing fetched twice, the duplicate included.
    expect(pop.retrieved.sort()).toEqual(['u1', 'u2', 'u2-copy', 'u3']);
    expect((await freshAccount(kim.id)).syncState.skipped?.sort()).toEqual(['old', 'u2-copy']);
    const rows = await (await personal(admin, true)).mail.list({ accountId: kim.id });
    expect(rows.map((r) => r.subject).sort()).toEqual(['Befund', 'Neu', 'eAU']);
  });

  test('a reply is sent once over SMTP, threaded; a failed send can be sent again', async () => {
    const { replyDraft } = await import('./drafts');
    const { sendDraft, MailSendError } = await import('./send');
    const { setMailPassword } = await import('./secrets');
    const repos = await personal(admin, true);
    const [befund] = await repos.mail.list({ accountId: kim.id, q: 'Befund' });
    const original = await repos.mail.message(befund.id);
    const account = await repos.mail.account(kim.id);
    const draft = await repos.mail.createDraft(account!, replyDraft(account!, original!, 'Danke, erhalten.'));

    // Two sends at once: one goes out.
    const results = await Promise.allSettled([sendDraft(repos.mail, draft.id), sendDraft(repos.mail, draft.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(received).toHaveLength(1);
    expect(received[0].to).toEqual(['labor@kim.telematik']);
    expect(received[0].from).toBe('praxis@kim.telematik');
    expect(received[0].data).toMatch(/In-Reply-To: <u1@client\.de>/);
    expect(received[0].data).toMatch(/Subject: Re: Befund/);
    const sent = await repos.mail.message(draft.id);
    expect(sent?.status).toBe('sent');
    expect(sent?.messageIdHeader).toMatch(/^<.+@kim\.telematik>$/);
    await expect(sendDraft(repos.mail, draft.id)).rejects.toBeInstanceOf(MailSendError);
    expect(await repos.mail.deleteDraft(draft.id)).toBe(false);

    await setMailPassword(kim.id, 'outgoing', 'wrong');
    const second = await repos.mail.createDraft(account!, { toAddresses: [{ address: 'x@kim.telematik' }], ccAddresses: [], subject: 'Two', bodyText: 'b' });
    await expect(sendDraft(repos.mail, second.id)).rejects.toMatchObject({ code: 'failed' });
    const failed = await repos.mail.message(second.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBeTruthy();
    await setMailPassword(kim.id, 'outgoing', 'smtp-pw');
    await sendDraft(repos.mail, second.id);
    expect(received).toHaveLength(2);
  });

  test('a received message links to a case', async () => {
    const { linkToCase, caseLinks } = await import('@/core/cases/links');
    const repos = await personal(admin, true);
    const [message] = await repos.mail.list({ accountId: kim.id, q: 'eAU' });
    const c = await repos.cases.create({ title: 'Krankmeldung' });
    await linkToCase(repos, c.id, { entityType: 'mail', entityId: message.id });
    const links = await caseLinks(repos, c.id);
    expect(links?.map((l) => [l.entityType, l.label])).toEqual([['mail', 'eAU']]);
    // Another user's case cannot link it.
    const other = await personal(erin);
    const theirs = await other.cases.create({ title: 'x' });
    await expect(linkToCase(other, theirs.id, { entityType: 'mail', entityId: message.id })).rejects.toThrow(/not found/);
  });
});
