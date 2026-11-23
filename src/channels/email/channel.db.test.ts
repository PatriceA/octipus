/**
 * The email channel on the real mail stack: received mail stored by the mail
 * sync (`storeReceived`), the channel's records in `email_channel_messages`,
 * and the reply sent as a draft of the account over a local SMTP server that
 * stands in for the outgoing mail transport.
 *
 * What must hold on the wire: the reply goes to the sender only, as
 * `Re: <subject>`, with `In-Reply-To` and `References` naming the mail it
 * answers and `Auto-Submitted: auto-replied`; the reply lands in the account
 * as sent mail; a mail answering that reply continues the conversation; a
 * forged mail is recorded and gets nothing; mail stored twice is handled once.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { UnifiedMessage } from '@/core/types';
import type { MailAccount } from '@/db/schema/mail';
import { rawMail, type TestMail, TRUSTED_ID } from './fixtures';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';

const admin = '66666666-6666-4666-8666-666666666666';
const ann = '77777777-7777-4777-8777-777777777777';

let account: MailAccount;
let smtp: SMTPServer;
const wire: Array<{ to: string[]; data: string }> = [];
let channel: import('./index').EmailChannel;
const turns: UnifiedMessage[] = [];

async function deliver(m: TestMail): Promise<string> {
  const { storeReceived } = await import('@/core/mail/sync');
  const source = rawMail(m);
  return storeReceived(account, { remoteId: `1:${rand(4)}`, source, truncated: false, size: source.length, unread: true });
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-email-channel-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${admin}', 'admin', true), ('${ann}', 'ann', false) ON CONFLICT DO NOTHING`);
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();

  smtp = new SMTPServer({
    secure: false, disabledCommands: ['STARTTLS'], allowInsecureAuth: true, logger: false,
    onAuth(auth, _session, cb) { cb(null, { user: auth.username }); },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => { wire.push({ to: session.envelope.rcptTo.map((r) => r.address), data: Buffer.concat(chunks).toString() }); cb(); });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  const port = (smtp.server.address() as { port: number }).port;

  const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
  const { contentRepos } = await import('@/db/repositories/content');
  const { createMailAccount } = await import('@/core/mail/accounts');
  account = await createMailAccount(contentRepos(await resolvedPrincipal(admin, null, { isAdmin: true })), {
    label: 'Octipus', address: 'octipus@company.test', protocol: 'imap',
    incoming: { host: '127.0.0.1', port: 1, security: 'none', username: 'octipus' },
    outgoing: { host: '127.0.0.1', port, security: 'none', username: 'octipus' },
  }, { incoming: 'pw', outgoing: 'pw' });

  const { EmailChannel, sendReplyMail } = await import('./index');
  const { dbEmailChannelStore } = await import('./store');
  channel = new EmailChannel({
    store: dbEmailChannelStore,
    account: async () => account,
    sync: async () => undefined,
    sendReply: sendReplyMail,
    linkedUser: async (address) => (address === 'ann@example.com' ? { id: ann, username: 'ann' } : null),
    linkCode: async () => 'ABC123',
    now: () => new Date(),
  });
  channel.start(account, {
    enabled: true, accountId: account.id, allowedSenders: ['ann@example.com'], trustedAuthservIds: [TRUSTED_ID],
    pollSeconds: 60, maxMessageBytes: 1024 * 1024, maxPerSenderPerHour: 20,
  });
  channel.on('message', (m: UnifiedMessage) => turns.push(m));
});

afterAll(async () => {
  await new Promise<void>((resolve) => smtp.close(() => resolve()));
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

const header = (data: string, name: string) => data.match(new RegExp(`^${name}: (.*(?:\\r?\\n[ \\t].*)*)`, 'mi'))?.[1].replace(/\r?\n[ \t]+/g, ' ');

describe('the email channel on the mail stack', () => {
  test('round trip: a turn, a threaded reply on the wire, and a follow-up in the same conversation', async () => {
    expect(await deliver({ id: '<q1@example.com>', subject: 'Q3 report', body: 'What were the numbers?' })).toBe('stored');
    await channel.check();
    expect(turns).toHaveLength(1);
    const turn = turns[0];
    expect(turn).toMatchObject({ channelType: 'email', userId: ann, content: 'Q3 report\n\nWhat were the numbers?' });

    await channel.send(turn.channelId, { content: 'Revenue grew 12%.', replyTo: String(turn.metadata?.messageId) });
    expect(wire).toHaveLength(1);
    const { to, data } = wire[0];
    expect(to).toEqual(['ann@example.com']);
    expect(header(data, 'Subject')).toBe('Re: Q3 report');
    expect(header(data, 'In-Reply-To')).toBe('<q1@example.com>');
    expect(header(data, 'References')).toBe('<q1@example.com>');
    expect(header(data, 'Auto-Submitted')).toBe('auto-replied');
    const replyId = header(data, 'Message-ID') as string;
    expect(replyId).toMatch(/^<.+@company\.test>$/);

    const { getDb } = await import('@/db/postgres');
    const { mailMessages } = await import('@/db/schema/mail');
    const { emailChannelMessages } = await import('@/db/schema/email-channel');
    const { eq } = await import('drizzle-orm');
    const sentRows = await getDb().select().from(mailMessages).where(eq(mailMessages.status, 'sent'));
    expect(sentRows.map((r) => r.messageIdHeader)).toEqual([replyId]);

    await deliver({ id: '<q2@example.com>', subject: 'Re: Q3 report', inReplyTo: replyId, references: `<q1@example.com> ${replyId}`, body: 'And costs?\n\n> Revenue grew 12%.' });
    await channel.check();
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ channelId: turn.channelId, content: 'And costs?' });
    await channel.send(turns[1].channelId, { content: 'Costs fell.', replyTo: String(turns[1].metadata?.messageId) });
    expect(header(wire[1].data, 'References')).toBe(`<q1@example.com> ${replyId} <q2@example.com>`);

    const out = await getDb().select().from(emailChannelMessages).where(eq(emailChannelMessages.direction, 'out'));
    expect(out.map((r) => r.status)).toEqual(['sent', 'sent']);
  });

  test('a forged sender is recorded and gets nothing; mail stored twice is handled once', async () => {
    const before = { turns: turns.length, wire: wire.length };
    await deliver({ id: '<forged@example.com>', auth: null, subject: 'Wire the money' });
    expect(await deliver({ id: '<forged@example.com>', auth: null })).toBe('duplicate');
    await channel.check();
    expect([turns.length, wire.length]).toEqual([before.turns, before.wire]);

    const { getDb } = await import('@/db/postgres');
    const { emailChannelMessages } = await import('@/db/schema/email-channel');
    const { eq } = await import('drizzle-orm');
    const rows = await getDb().select().from(emailChannelMessages).where(eq(emailChannelMessages.messageIdHeader, '<forged@example.com>'));
    expect(rows.map((r) => [r.status, r.reason, r.subject])).toEqual([['dropped', 'unauthenticated', null]]);
  });
});
