/**
 * The email channel end to end over a fake mail transport: mail in through an
 * in-memory mailbox and record store, replies out through a fake mailbox that
 * keeps what would have been drafted, sent, or sent without a copy.
 *
 * What must hold: an allowed, authenticated (DMARC pass), linked sender gets a
 * turn and one threaded reply to them alone — a draft by default, sent only in
 * send mode; a reply to it continues the conversation; forged,
 * unauthenticated, unknown, automatic, repeated and late mail gets no answer
 * and is recorded; a flood does not push real mail out unrecorded; HTML-only
 * mail arrives as text; a forward keeps the forwarded mail; oversize mail is
 * not run; a mailbox that can no longer serve stops the channel.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import type { EmailChannelConfig } from '@/config/schema';
import type { UnifiedMessage } from '@/core/types';
import type { MailAccount } from '@/db/schema/mail';
import { rawMail, type TestMail, TRUSTED_ID } from './fixtures';
import { type ChannelMailbox, EmailChannel, type EmailChannelDeps } from './index';
import type { EmailChannelStore, InboundPatch, InboundRecord, OutboundRow } from './store';

interface Row extends Partial<InboundPatch> {
  id: string; accountId: string; direction: 'in' | 'out'; mailMessageId?: string | null; createdAt: Date;
}

const ACCOUNT = { id: 'acct-1', address: 'octipus@company.test', userId: 'admin', workspaceId: null, protocol: 'imap', outgoing: {}, enabled: true, lastSyncAt: new Date() } as unknown as MailAccount;

function memoryStore(rows: Row[]): EmailChannelStore {
  let n = 0;
  return {
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
    async answeredSince(_accountId, address, since) {
      return rows.filter((r) => r.direction === 'in' && r.address === address && (r.status === 'accepted' || r.status === 'answered') && r.createdAt >= since).length;
    },
    async replyTarget(_accountId, threadKey, id) {
      const r = [...rows].reverse().find((x) => x.direction === 'in' && x.threadKey === threadKey && (x.status === 'accepted' || x.status === 'answered') && (!id || x.id === id));
      return r ? { id: r.id, address: r.address as string, userId: r.userId ?? null, messageIdHeader: r.messageIdHeader as string, threadKey, subject: r.subject ?? '', references: r.references ?? null } : null;
    },
    async recordOutbound(row: OutboundRow) {
      rows.push({ ...row, id: `out-${++n}`, direction: 'out', createdAt: new Date() });
    },
    async prune() {},
  };
}

const SETTINGS: EmailChannelConfig = {
  enabled: true, replyMode: 'send', accountId: ACCOUNT.id, allowedSenders: ['Ann@Example.com', 'mallory@evil.test'],
  trustedAuthservIds: [TRUSTED_ID], pollSeconds: 60, maxMessageBytes: 64 * 1024, maxPerSenderPerHour: 3,
};

interface Out { how: 'draft' | 'send' | 'unstored'; to: InboundRecord; text: string; messageId: string }

let mailbox: Map<string, { raw: Buffer; size: number; date: Date }>;
let rows: Row[];
let out: Out[];
let turns: UnifiedMessage[];
let account: MailAccount | null;
let linked: Map<string, string>;
let channel: EmailChannel;
let mailN = 0;

function deliver(m: TestMail = {}, date = new Date()): string {
  const id = `mail-${++mailN}`;
  const raw = rawMail(m);
  mailbox.set(id, { raw, size: raw.length, date });
  return id;
}

function fakeMailbox(): ChannelMailbox | null {
  if (!account) return null;
  const keep = (how: Out['how']) => async (to: InboundRecord, text: string) => {
    const messageId = `<reply-${out.length + 1}@company.test>`;
    out.push({ how, to, text, messageId });
    return messageId;
  };
  return {
    account,
    unseen: async (_since, limit) => [...mailbox.entries()]
      .filter(([id]) => !rows.some((r) => r.mailMessageId === id))
      .slice(0, limit).map(([id, m]) => ({ id, size: m.size, date: m.date })),
    raw: async (id) => mailbox.get(id)?.raw ?? null,
    draft: keep('draft'),
    send: async (to, text) => ({ mailMessageId: 'sent-row', messageIdHeader: await keep('send')(to, text) }),
    sendUnstored: keep('unstored'),
  };
}

async function start(settings: Partial<EmailChannelConfig> = {}): Promise<void> {
  const deps: EmailChannelDeps = {
    store: memoryStore(rows),
    mailbox: async () => fakeMailbox(),
    sync: async () => undefined,
    linkedUser: async (address) => (linked.has(address) ? { id: linked.get(address) as string, username: 'x' } : null),
    linkCode: async () => 'ABC123',
    now: () => new Date(),
  };
  channel = new EmailChannel(deps);
  expect(await channel.open({ ...SETTINGS, ...settings })).toBe(true);
  channel.on('message', (m: UnifiedMessage) => turns.push(m));
}

beforeEach(async () => {
  mailbox = new Map();
  rows = [];
  out = [];
  turns = [];
  account = ACCOUNT;
  linked = new Map([['ann@example.com', 'user-ann']]);
  await start();
});

const recordOf = (mailId: string) => rows.find((r) => r.mailMessageId === mailId);

describe('an allowed, authenticated, linked sender', () => {
  test('send mode: a turn, one threaded reply to them alone, and a reply to it continues the conversation', async () => {
    deliver({ id: '<first@example.com>', subject: 'Q3 report', body: 'What were the numbers?', references: '<older@example.com>' });
    await channel.check();
    expect(turns).toHaveLength(1);
    const [turn] = turns;
    expect(turn).toMatchObject({ channelType: 'email', userId: 'user-ann', content: 'Q3 report\n\nWhat were the numbers?' });

    await channel.send(turn.channelId, { content: 'Revenue grew 12%.', replyTo: String(turn.metadata?.messageId) });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ how: 'send', text: 'Revenue grew 12%.' });
    expect(out[0].to).toMatchObject({ address: 'ann@example.com', messageIdHeader: '<first@example.com>', subject: 'Q3 report', references: '<older@example.com>' });

    deliver({ id: '<second@example.com>', subject: 'Re: Q3 report', inReplyTo: out[0].messageId, references: `<first@example.com> ${out[0].messageId}`,
      body: 'And costs?\n\nOn Mon, 23 Nov 2026, Octipus <octipus@company.test> wrote:\n> Revenue grew 12%.' });
    await channel.check();
    expect(turns).toHaveLength(2);
    expect(turns[1].channelId).toBe(turn.channelId);
    expect(turns[1].content).toBe('And costs?');

    deliver({ id: '<third@example.com>', subject: 'Something else' });
    await channel.check();
    expect(turns[2].channelId).not.toBe(turn.channelId);
  });

  test('draft mode (the default): the answer is saved as a draft, nothing is sent', async () => {
    await start({ replyMode: 'draft' });
    deliver({ subject: 'Q3 report' });
    await channel.check();
    await channel.send(turns[0].channelId, { content: 'Revenue grew 12%.', replyTo: String(turns[0].metadata?.messageId) });
    expect(out.map((o) => o.how)).toEqual(['draft']);
    expect(rows.find((r) => r.direction === 'out')).toMatchObject({ status: 'drafted', mailMessageId: '<reply-1@company.test>' });
  });

  test('a conversation whose address was unlinked since gets no answer', async () => {
    deliver();
    await channel.check();
    linked.delete('ann@example.com');
    await expect(channel.send(turns[0].channelId, { content: 'x', replyTo: String(turns[0].metadata?.messageId) })).rejects.toThrow(/no longer linked/);
    linked.set('ann@example.com', 'someone-else');
    await expect(channel.send(turns[0].channelId, { content: 'x' })).rejects.toThrow(/no longer linked/);
    expect(out).toEqual([]);
  });

  test('HTML-only mail arrives as text', async () => {
    deliver({ subject: 'Re: x', html: '<p>Please <b>check</b> this</p><script>steal()</script>' });
    await channel.check();
    expect(turns[0].content).toBe('Please check this');
  });

  test('a forward keeps the forwarded mail, fenced as untrusted, below the sender\'s own text', async () => {
    deliver({ subject: 'Fwd: Invoice', body: 'Please summarise the mail below.\n\n---------- Forwarded message ---------\nFrom: Bank <x@bank.test>\nSubject: Invoice\n\nYou owe 5000 EUR by Friday.' });
    await channel.check();
    const { content } = turns[0];
    expect(content.startsWith('Please summarise the mail below.')).toBe(true);
    expect(content).toContain('You owe 5000 EUR by Friday.');
    expect(content).toMatch(/<untrusted_tool_result source="forwarded mail">/);
  });

  test('oversize mail is not run; the sender is told', async () => {
    const id = deliver({ body: 'x'.repeat(70 * 1024) });
    await channel.check();
    expect(turns).toEqual([]);
    expect(recordOf(id)).toMatchObject({ status: 'answered', reason: 'too_large' });
    expect(out[0].text).toMatch(/larger than/);
  });

  test('more mails than the hourly limit are dropped without an answer', async () => {
    for (let i = 0; i < 4; i++) deliver({ subject: `Request ${i}` });
    await channel.check();
    expect(turns).toHaveLength(3);
    expect(rows.filter((r) => r.reason === 'rate_limited')).toHaveLength(1);
  });
});

describe('mail that is never answered', () => {
  const forged = [
    ['no Authentication-Results', { auth: null }],
    ['an untrusted authserv-id', { auth: 'mx.evil.test; dmarc=pass header.from=example.com' }],
    ['a pass written below a failing trusted header', { auth: `${TRUSTED_ID}; dmarc=fail header.from=example.com`, below: [`Authentication-Results: ${TRUSTED_ID}; dmarc=pass header.from=example.com`] }],
    ['DKIM and SPF pass without DMARC', { auth: `${TRUSTED_ID}; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com` }],
    ['an SPF quoted local part carrying a DMARC pass', { auth: `${TRUSTED_ID}; spf=pass smtp.mailfrom="a;dmarc=pass()header.from=example.com;"@attacker.test` }],
    ['a DKIM selector carrying a DMARC pass', { auth: `${TRUSTED_ID}; dkim=pass header.d=attacker.test header.s="s;dmarc=pass()header.from=example.com;"` }],
  ] as const;
  test.each(forged)('%s: dropped silently and recorded', async (_name, mail) => {
    const id = deliver(mail as TestMail);
    await channel.check();
    expect([turns, out]).toEqual([[], []]);
    expect(recordOf(id)).toMatchObject({ status: 'dropped', reason: 'unauthenticated', address: 'ann@example.com' });
  });

  test('an authenticated sender who is not allow-listed gets no answer', async () => {
    const id = deliver({ from: 'bob@example.com' });
    await channel.check();
    expect([turns, out]).toEqual([[], []]);
    expect(recordOf(id)).toMatchObject({ status: 'dropped', reason: 'not_allowed' });
  });

  test('auto replies, bounces and a bare CR in the headers are not answered', async () => {
    const auto = deliver({ extra: ['Auto-Submitted: auto-replied'], subject: 'Out of office' });
    const bounce = deliver({ from: 'MAILER-DAEMON@example.com' });
    const bareCr = deliver({ extra: ['X-Note: a\rFrom: ann@example.com'] });
    await channel.check();
    expect([turns, out]).toEqual([[], []]);
    expect(recordOf(auto)?.reason).toBe('auto_submitted');
    expect(recordOf(bounce)?.reason).toBe('bounce');
    expect(recordOf(bareCr)?.reason).toBe('malformed');
  });

  test('the same Message-ID twice gets one turn', async () => {
    deliver({ id: '<dup@example.com>' });
    const again = deliver({ id: '<dup@example.com>' });
    await channel.check();
    expect(turns).toHaveLength(1);
    expect(recordOf(again)).toMatchObject({ status: 'dropped', reason: 'duplicate' });
  });

  test('mail that arrived before the lookback is recorded as too old, not answered', async () => {
    const id = deliver({}, new Date(Date.now() - 3 * 60 * 60_000));
    await channel.check();
    expect([turns, out]).toEqual([[], []]);
    expect(recordOf(id)).toMatchObject({ status: 'dropped', reason: 'too_old' });
  });

  test('a flood of forged mail is drained in one check: the real mail behind it still gets its turn', async () => {
    for (let i = 0; i < 300; i++) deliver({ auth: null, subject: `spam ${i}` });
    deliver({ subject: 'The real one' });
    await channel.check();
    expect(turns.map((t) => t.content.split('\n')[0])).toEqual(['The real one']);
    expect(rows.filter((r) => r.reason === 'unauthenticated')).toHaveLength(300);
  });

  test('a failure part way records the mail instead of leaving it claimed', async () => {
    linked = new Map();
    const deps = (channel as unknown as { deps: EmailChannelDeps }).deps;
    deps.linkedUser = async () => { throw new Error('database down'); };
    const id = deliver();
    await channel.check();
    expect(recordOf(id)).toMatchObject({ status: 'dropped', reason: 'error' });
  });
});

describe('linking', () => {
  const mallory = { from: 'mallory@evil.test', auth: `${TRUSTED_ID}; dmarc=pass header.from=evil.test` };

  test('send mode: the link code goes out without a copy; other mail gets instructions; no turn', async () => {
    deliver({ ...mallory, subject: 'link' });
    deliver({ ...mallory, subject: 'hello' });
    await channel.check();
    expect(turns).toEqual([]);
    expect(out.map((o) => [o.how, o.to.address])).toEqual([['unstored', 'mallory@evil.test'], ['send', 'mallory@evil.test']]);
    expect(out[0].text).toContain('ABC123');
    expect(out[1].text).toMatch(/not linked/);
  });

  test('draft mode: the link code is a draft like any answer', async () => {
    await start({ replyMode: 'draft' });
    deliver({ ...mallory, subject: 'link' });
    await channel.check();
    expect(out.map((o) => o.how)).toEqual(['draft']);
  });
});

describe('the mailbox', () => {
  test('one that can no longer serve (disabled, gone) stops the channel at the next check', async () => {
    account = { ...ACCOUNT, enabled: false } as MailAccount;
    deliver();
    await channel.check();
    expect(channel.isConnected()).toBe(false);
    expect(turns).toEqual([]);
  });

  test('none found (not an admin\'s personal mailbox) does not start', async () => {
    account = null;
    const c = new EmailChannel({ store: memoryStore([]), mailbox: async () => fakeMailbox(), sync: async () => undefined, linkedUser: async () => null, linkCode: async () => '', now: () => new Date() });
    expect(await c.open(SETTINGS)).toBe(false);
  });
});
