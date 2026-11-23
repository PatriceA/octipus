/**
 * The email channel end to end over a fake mail transport: mail in through an
 * in-memory mailbox and record store, replies out through a fake sender that
 * keeps what would have gone over SMTP.
 *
 * What must hold: an allowed, authenticated, linked sender gets a turn and one
 * threaded reply (`Re:`, In-Reply-To, References) to them alone; a reply to
 * that reply continues the same conversation; forged, unauthenticated,
 * unknown, automatic and repeated mail gets no answer at all, and is recorded;
 * HTML-only mail arrives as text; oversize mail is not run.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import type { EmailChannelConfig } from '@/config/schema';
import type { UnifiedMessage } from '@/core/types';
import type { MailAccount } from '@/db/schema/mail';
import { rawMail, type TestMail, TRUSTED_ID } from './fixtures';
import { EmailChannel, type EmailChannelDeps, REPLY_HEADERS } from './index';
import type { EmailChannelStore, InboundPatch, InboundRecord, OutboundRow } from './store';

interface Row extends Partial<InboundPatch> {
  id: string; accountId: string; direction: 'in' | 'out'; mailMessageId?: string; createdAt: Date;
}

const ACCOUNT = { id: 'acct-1', address: 'octipus@company.test', userId: 'owner', workspaceId: null, protocol: 'imap', outgoing: {}, enabled: true, lastSyncAt: new Date() } as unknown as MailAccount;

function memoryStore(mailbox: Map<string, { raw: Buffer; size: number }>, rows: Row[]): EmailChannelStore {
  let n = 0;
  return {
    async unseen() {
      return [...mailbox.entries()].filter(([id]) => !rows.some((r) => r.mailMessageId === id)).map(([id, m]) => ({ id, size: m.size }));
    },
    async raw(id) { return mailbox.get(id)?.raw ?? null; },
    async claim(accountId, mailMessageId) {
      if (rows.some((r) => r.mailMessageId === mailMessageId)) return null;
      const id = `rec-${++n}`;
      rows.push({ id, accountId, mailMessageId, direction: 'in', status: 'processing', createdAt: new Date() });
      return id;
    },
    async finish(id, patch) { Object.assign(rows.find((r) => r.id === id) as Row, patch); },
    async seen(accountId, header, exceptId) { return rows.some((r) => r.accountId === accountId && r.messageIdHeader === header && r.id !== exceptId); },
    async threadOf(accountId, userId, ids) {
      return [...rows].reverse().find((r) => r.accountId === accountId && r.userId === userId && r.threadKey && ids.includes(r.messageIdHeader ?? ''))?.threadKey ?? null;
    },
    async answeredSince(accountId, address, since) {
      return rows.filter((r) => r.direction === 'in' && r.address === address && (r.status === 'accepted' || r.status === 'answered') && r.createdAt >= since).length;
    },
    async replyTarget(accountId, threadKey, id) {
      const r = [...rows].reverse().find((x) => x.direction === 'in' && x.threadKey === threadKey && (x.status === 'accepted' || x.status === 'answered') && (!id || x.id === id));
      return r ? { id: r.id, address: r.address as string, userId: r.userId ?? null, messageIdHeader: r.messageIdHeader as string, threadKey, subject: r.subject ?? '', references: r.references ?? null } : null;
    },
    async recordOutbound(row: OutboundRow) {
      rows.push({ ...row, id: `out-${++n}`, direction: 'out', createdAt: new Date() });
    },
    async pruneDropped() { return 0; },
  };
}

const SETTINGS: EmailChannelConfig = {
  enabled: true, accountId: ACCOUNT.id, allowedSenders: ['Ann@Example.com', 'mallory@evil.test'],
  trustedAuthservIds: [TRUSTED_ID], pollSeconds: 60, maxMessageBytes: 64 * 1024, maxPerSenderPerHour: 3,
};

let mailbox: Map<string, { raw: Buffer; size: number }>;
let rows: Row[];
let sent: Array<{ to: InboundRecord; text: string; messageId: string }>;
let turns: UnifiedMessage[];
let channel: EmailChannel;
let mailN = 0;

function deliver(m: TestMail = {}): string {
  const id = `mail-${++mailN}`;
  const raw = rawMail(m);
  mailbox.set(id, { raw, size: raw.length });
  return id;
}

beforeEach(() => {
  mailbox = new Map();
  rows = [];
  sent = [];
  turns = [];
  const deps: EmailChannelDeps = {
    store: memoryStore(mailbox, rows),
    account: async () => ACCOUNT,
    sync: async () => undefined,
    sendReply: async (_account, to, text) => {
      const messageId = `<reply-${sent.length + 1}@company.test>`;
      sent.push({ to, text, messageId });
      return messageId;
    },
    linkedUser: async (address) => (address === 'ann@example.com' ? { id: 'user-ann', username: 'ann' } : null),
    linkCode: async () => 'ABC123',
    now: () => new Date(),
  };
  channel = new EmailChannel(deps);
  channel.start(ACCOUNT, SETTINGS);
  channel.on('message', (m: UnifiedMessage) => turns.push(m));
});

const reasonOf = (mailId: string) => rows.find((r) => r.mailMessageId === mailId);

describe('an allowed, authenticated, linked sender', () => {
  test('gets a turn, and the answer goes back threaded to them alone; a reply to it continues the conversation', async () => {
    deliver({ id: '<first@example.com>', subject: 'Q3 report', body: 'What were the numbers?', references: '<older@example.com>' });
    await channel.check();
    expect(turns).toHaveLength(1);
    const [turn] = turns;
    expect(turn).toMatchObject({ channelType: 'email', userId: 'user-ann', content: 'Q3 report\n\nWhat were the numbers?' });

    await channel.send(turn.channelId, { content: 'Revenue grew 12%.', replyTo: String(turn.metadata?.messageId) });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toMatchObject({ address: 'ann@example.com', messageIdHeader: '<first@example.com>', subject: 'Q3 report', references: '<older@example.com>' });
    expect(sent[0].text).toBe('Revenue grew 12%.');

    // Ann answers the reply: same conversation, quoted history gone, the Re: subject not prepended.
    deliver({ id: '<second@example.com>', subject: 'Re: Q3 report', inReplyTo: sent[0].messageId, references: `<first@example.com> ${sent[0].messageId}`,
      body: 'And costs?\n\nOn Mon, 23 Nov 2026, Octipus <octipus@company.test> wrote:\n> Revenue grew 12%.' });
    await channel.check();
    expect(turns).toHaveLength(2);
    expect(turns[1].channelId).toBe(turn.channelId);
    expect(turns[1].content).toBe('And costs?');

    // A new mail (no reference) is a new conversation.
    deliver({ id: '<third@example.com>', subject: 'Something else' });
    await channel.check();
    expect(turns[2].channelId).not.toBe(turn.channelId);
  });

  test('replies are marked as automatic, so other robots do not answer them', () => {
    expect(REPLY_HEADERS['Auto-Submitted']).toBe('auto-replied');
  });

  test('HTML-only mail arrives as text', async () => {
    deliver({ subject: 'Re: x', html: '<p>Please <b>check</b> this</p><script>steal()</script>' });
    await channel.check();
    expect(turns[0].content).toBe('Please check this');
  });

  test('oversize mail is not run; the sender is told', async () => {
    const id = deliver({ body: 'x'.repeat(70 * 1024) });
    await channel.check();
    expect(turns).toEqual([]);
    expect(reasonOf(id)).toMatchObject({ status: 'answered', reason: 'too_large' });
    expect(sent[0].text).toMatch(/larger than/);
  });

  test('more mails than the hourly limit are dropped without an answer', async () => {
    for (let i = 0; i < 4; i++) deliver({ subject: `Request ${i}` });
    await channel.check();
    expect(turns).toHaveLength(3);
    expect(rows.filter((r) => r.reason === 'rate_limited')).toHaveLength(1);
  });
});

describe('mail that is never answered', () => {
  test('a forged From (no or failing authentication) is dropped silently and recorded', async () => {
    const none = deliver({ auth: null });
    const untrusted = deliver({ auth: 'mx.evil.test; dmarc=pass header.from=example.com' });
    const failing = deliver({ auth: `${TRUSTED_ID}; dmarc=fail header.from=example.com`, below: [`Authentication-Results: ${TRUSTED_ID}; dmarc=pass header.from=example.com`] });
    await channel.check();
    expect(turns).toEqual([]);
    expect(sent).toEqual([]);
    for (const id of [none, untrusted, failing]) expect(reasonOf(id)).toMatchObject({ status: 'dropped', reason: 'unauthenticated', address: 'ann@example.com' });
  });

  test('an authenticated sender who is not allow-listed gets no answer', async () => {
    const id = deliver({ from: 'bob@example.com' });
    await channel.check();
    expect([turns, sent]).toEqual([[], []]);
    expect(reasonOf(id)).toMatchObject({ status: 'dropped', reason: 'not_allowed' });
  });

  test('auto replies and bounces are not answered: no loop', async () => {
    const auto = deliver({ extra: ['Auto-Submitted: auto-replied'], subject: 'Out of office' });
    const bounce = deliver({ from: 'MAILER-DAEMON@example.com' });
    await channel.check();
    expect([turns, sent]).toEqual([[], []]);
    expect(reasonOf(auto)?.reason).toBe('auto_submitted');
    expect(reasonOf(bounce)?.reason).toBe('bounce');
  });

  test('the same Message-ID twice gets one turn', async () => {
    deliver({ id: '<dup@example.com>' });
    const again = deliver({ id: '<dup@example.com>' });
    await channel.check();
    expect(turns).toHaveLength(1);
    expect(reasonOf(again)).toMatchObject({ status: 'dropped', reason: 'duplicate' });
  });

  test('a mail is claimed once: a second check does not handle it again', async () => {
    deliver();
    await channel.check();
    await channel.check();
    expect(turns).toHaveLength(1);
  });
});

describe('linking', () => {
  test('an allowed, authenticated, unlinked sender gets a link code for the subject "link", instructions otherwise; no turn', async () => {
    deliver({ from: 'mallory@evil.test', subject: 'link', auth: `${TRUSTED_ID}; dmarc=pass header.from=evil.test` });
    deliver({ from: 'mallory@evil.test', subject: 'hello', auth: `${TRUSTED_ID}; dmarc=pass header.from=evil.test` });
    await channel.check();
    expect(turns).toEqual([]);
    expect(sent.map((s) => s.to.address)).toEqual(['mallory@evil.test', 'mallory@evil.test']);
    expect(sent[0].text).toContain('ABC123');
    expect(sent[1].text).toMatch(/not linked/);
  });
});
