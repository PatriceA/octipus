/**
 * The host scopes `mail:read`, `mail:draft`, `mail:send`, `calendar:read` and
 * `calendar:write` (docs/PLUGIN-PACKAGES.md#mail-and-calendar), end to end
 * over HTTP through a package's egress proxy, with tokens minted as a call's
 * would be.
 *
 * What must hold:
 * - a package reads only the calling user's mail, and only within its
 *   maxProtection: above it a message is left out of a list (in the query)
 *   and refused when named; the connected inbox counts as level 4; what is
 *   read raises the calling session;
 * - drafts are the user's, marked with the package and tool, at least at the
 *   level the call read; a package changes and sends only its own drafts;
 * - a send is refused while the call holds data above what the package may
 *   carry out; the inbox sends to one recipient;
 * - the calendars count as the admin's level: read only within maxProtection,
 *   written only from a call at or below it; a package changes only the
 *   events it created; another publisher, or an uninstall, ends that;
 * - a source's module off, or the user's rule denying it, refuses;
 * - every request is audited.
 *
 * Backed by ephemeral PGlite; the providers (Gmail, Graph, SMTP) are stubs.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RunningServer } from '@/api/http';
import type { HostTokenGrant } from './host-api';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';
process.env.WORKSPACE_PATH ??= mkdtempSync(join(tmpdir(), 'octipus-host-mail-ws-'));

const ALICE = { id: '11111111-1111-4111-8111-111111111111', username: 'alice' };
const BOB = { id: '22222222-2222-4222-8222-222222222222', username: 'bob' };
const ALICE_ACCOUNT = '33333333-3333-4333-8333-333333333333';
const BOB_ACCOUNT = '44444444-4444-4444-8444-444444444444';

const fx = vi.hoisted(() => ({
  toolsOff: new Set<string>(),
  modulesOff: new Set<string>(),
  denied: new Set<string>(),
  inbox: 'google' as 'google' | 'microsoft' | null,
  calls: [] as Array<{ fn: string; args: unknown[] }>,
  eventSeq: 0,
}));

vi.mock('@/core/modules/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/modules/registry')>();
  return { ...actual, isToolOn: (id: string) => !fx.toolsOff.has(id), isModuleOn: (id: string) => !fx.modulesOff.has(id) };
});
vi.mock('@/security/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/security/permissions')>();
  return { ...actual, getPermissionManager: () => ({ check: async (_u: string, tool: string, action: string) => ({ level: fx.denied.has(`${tool}.${action}`) ? 'DENY' : 'ALLOW' }) }) };
});
vi.mock('@/core/email/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/email/providers')>();
  return {
    ...actual,
    detectProvider: async () => fx.inbox,
    gmailApi: async (...args: unknown[]) => { fx.calls.push({ fn: 'gmailApi', args }); return { id: 'gmail-draft-1' }; },
    graphApi: async (...args: unknown[]) => { fx.calls.push({ fn: 'graphApi', args }); return { id: 'graph-draft-1' }; },
  };
});
vi.mock('@/core/email/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/email/service')>();
  return {
    ...actual,
    getInbox: async (userId: string, limit: number, pageToken?: string) => {
      fx.calls.push({ fn: 'getInbox', args: [userId, limit, pageToken] });
      return { provider: fx.inbox, items: [{ id: 'g1', provider: fx.inbox, from: { email: 'x@example.com' }, subject: 'Hi', snippet: 'hello', receivedAt: '2026-11-01T00:00:00Z', unread: true }], nextPageToken: 'p2' };
    },
    getMessage: async (userId: string, provider: string, id: string) => {
      fx.calls.push({ fn: 'getMessage', args: [userId, provider, id] });
      return { id, provider, from: { email: 'x@example.com' }, subject: 'Hi', snippet: 'hello', receivedAt: '2026-11-01T00:00:00Z', unread: false, body: 'Inbox body' };
    },
    sendReply: async (...args: unknown[]) => { fx.calls.push({ fn: 'sendReply', args }); return { sent: true }; },
  };
});
vi.mock('@/core/email/drafts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/email/drafts')>();
  return { ...actual, saveReplyDraft: async (...args: unknown[]) => { fx.calls.push({ fn: 'saveReplyDraft', args }); return { draftId: 'reply-draft-1', provider: args[1], to: 'x@example.com', subject: 'Re: Hi' }; } };
});
vi.mock('@/core/mail/send', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/mail/send')>();
  return { ...actual, sendDraft: async (_repo: unknown, id: string) => { fx.calls.push({ fn: 'sendDraft', args: [id] }); return { id, messageIdHeader: '<sent@test>' }; } };
});
vi.mock('@/core/calendar/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/calendar/events')>();
  return {
    ...actual,
    listCalendarEvents: async (userId: string, opts: unknown) => {
      fx.calls.push({ fn: 'listCalendarEvents', args: [userId, opts] });
      return { events: [{ id: 'e1', title: 'Standup', start: '2026-11-02T09:00:00Z', allDay: false, attendees: [{ email: 'bob@example.com' }], provider: 'google' }], providers: ['google'], partial: false };
    },
  };
});
vi.mock('@/core/calendar/manage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/calendar/manage')>();
  return {
    ...actual,
    writeCalendarEvent: async (userId: string, provider: string, input: unknown, id?: string) => {
      fx.calls.push({ fn: 'writeCalendarEvent', args: [userId, provider, input, id] });
      return { id: id ?? `evt-${++fx.eventSeq}` };
    },
  };
});

let server: RunningServer;
const proxies = new Map<string, import('@/security/egress-proxy').EgressProxy>();

async function hostApi(method: string, path: string, token: string, plugin: string, body?: unknown): Promise<{ status: number; body: any }> {
  const { startEgressProxy } = await import('@/security/egress-proxy');
  let proxy = proxies.get(plugin);
  if (!proxy) {
    proxy = await startEgressProxy({ label: plugin, allowed: [], hostApi: { host: '127.0.0.1', port: server.port } });
    proxies.set(plugin, proxy);
  }
  const { request } = await import('node:http');
  const port = proxy.port;
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port, path: `http://octipus-host.internal/api/plugin-host${path}`, method,
      headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let parsed: unknown = null; try { parsed = JSON.parse(data); } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, body: parsed }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const ALL = ['mail:read', 'mail:draft', 'mail:send', 'calendar:read', 'calendar:write'] as HostTokenGrant['scopes'];

async function token(over: Partial<HostTokenGrant> = {}, plugin = 'mailer'): Promise<string> {
  const { mintHostToken } = await import('./host-api');
  return mintHostToken({
    plugin, userId: ALICE.id, workspaceId: null, sessionId: `sess-${rand(4)}`, scopes: ALL, maxProtection: 4, tool: 'mail_tool', effect: 'external', ...over,
  }, 30_000).token;
}

async function query<T = any>(sql: string): Promise<T[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql)).rows as T[];
}

async function hostAudit(op: string): Promise<Array<Record<string, any>>> {
  const rows = await query<{ details: unknown }>(`SELECT details FROM audit_log WHERE resource_type = 'plugin_host' ORDER BY created_at`);
  return rows.map((r) => (typeof r.details === 'string' ? JSON.parse(r.details) : r.details) as Record<string, any>).filter((d) => d.op === op);
}

/** A received message of `account` (of `userId`) at `level` (null: unclear). */
async function received(account: string, userId: string, subject: string, level: number | null, date: string): Promise<string> {
  const [row] = await query<{ id: string }>(`INSERT INTO mail_messages (account_id, user_id, status, from_address, to_addresses, subject, snippet, body_text, protection_level, unread, date)
    VALUES ('${account}', '${userId}', 'received', '{"address":"sender@example.com"}', '[{"address":"me@example.com"}]', '${subject}', 'snippet of ${subject}', 'Body of ${subject}', ${level === null ? 'NULL' : level}, true, '${date}') RETURNING id`);
  return row.id;
}

let lvl1: string;
let lvl2: string;
let lvl3: string;
let unclear: string;
let bobsMail: string;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-host-mail-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${ALICE.id}', 'alice', true), ('${BOB.id}', 'bob', false) ON CONFLICT DO NOTHING`);
  for (const name of ['mailer', 'other']) {
    await executeRaw(`INSERT INTO plugin_packages (name, version, manifest, enabled) VALUES ('${name}', '1.0.0', '{"name":"${name}","version":"1.0.0"}', true)`);
  }
  const server_ = '{"host":"imap.example.com","port":993,"security":"tls","username":"u"}';
  await executeRaw(`INSERT INTO mail_accounts (id, user_id, label, address, protocol, incoming, outgoing, default_protection_level)
    VALUES ('${ALICE_ACCOUNT}', '${ALICE.id}', 'Work', 'alice@example.com', 'imap', '${server_}', '${server_}', 2),
           ('${BOB_ACCOUNT}', '${BOB.id}', 'Bob', 'bob@example.com', 'imap', '${server_}', '${server_}', 1)`);
  lvl1 = await received(ALICE_ACCOUNT, ALICE.id, 'one', 1, '2026-11-01T10:00:00Z');
  lvl2 = await received(ALICE_ACCOUNT, ALICE.id, 'two', 2, '2026-11-02T10:00:00Z');
  lvl3 = await received(ALICE_ACCOUNT, ALICE.id, 'three', 3, '2026-11-03T10:00:00Z');
  unclear = await received(ALICE_ACCOUNT, ALICE.id, 'unclear', null, '2026-11-04T10:00:00Z');
  bobsMail = await received(BOB_ACCOUNT, BOB.id, 'bobs', 1, '2026-11-05T10:00:00Z');
  const { App, listen } = await import('@/api/http');
  const { pluginHostRoutes } = await import('@/api/routes/plugin-host');
  server = listen(new App({ prefix: '/api' }).use(pluginHostRoutes), { hostname: '127.0.0.1', port: 0 });
  await new Promise((r) => setTimeout(r, 50));
});

beforeEach(async () => {
  fx.toolsOff.clear();
  fx.modulesOff.clear();
  fx.denied.clear();
  fx.inbox = 'google';
  fx.calls.length = 0;
  // What a package read for a user persists across its calls; each test starts afresh.
  const { executeRaw } = await import('@/db/postgres');
  await executeRaw(`DELETE FROM kv_store WHERE key LIKE 'plugin-read-level:%'`);
});

afterAll(async () => {
  for (const proxy of proxies.values()) await proxy.close();
  server?.stop(true);
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('mail:read (Mail module)', () => {
  test('lists only the calling user\'s mail within maxProtection, in the query; raises the session', async () => {
    const sessionId = `sess-${rand(4)}`;
    const res = await hostApi('GET', '/mail/messages?limit=10', await token({ maxProtection: 2, sessionId }), 'mailer');
    expect(res.status).toBe(200);
    const ids = res.body.messages.map((m: { id: string }) => m.id);
    expect(ids).toEqual([lvl2, lvl1]);
    expect(ids).not.toContain(lvl3);
    expect(ids).not.toContain(unclear);
    expect(ids).not.toContain(bobsMail);
    expect(res.body.messages[0]).not.toHaveProperty('text');
    const { sessionProtectionLevel } = await import('@/core/protection/session-level');
    expect(sessionProtectionLevel(sessionId)).toBe(2);
    // A message without a level counts as 4.
    const all = await hostApi('GET', '/mail/messages?limit=10', await token({ maxProtection: 4 }), 'mailer');
    expect(all.body.messages.map((m: { id: string }) => m.id)).toEqual([unclear, lvl3, lvl2, lvl1]);
    expect(all.body.messages[0].protectionLevel).toBe(4);
  });

  test('pages with the cursor', async () => {
    const t = await token({ maxProtection: 4 });
    const first = await hostApi('GET', '/mail/messages?limit=2', t, 'mailer');
    expect(first.body.messages.map((m: { id: string }) => m.id)).toEqual([unclear, lvl3]);
    expect(first.body.next).toBeTruthy();
    const second = await hostApi('GET', `/mail/messages?limit=2&cursor=${encodeURIComponent(first.body.next)}`, t, 'mailer');
    expect(second.body.messages.map((m: { id: string }) => m.id)).toEqual([lvl2, lvl1]);
    expect((await hostApi('GET', '/mail/messages?cursor=garbage', t, 'mailer')).status).toBe(400);
  });

  test('reads one message within maxProtection; refuses above it and another user\'s', async () => {
    const t = await token({ maxProtection: 2 });
    const ok = await hostApi('GET', `/mail/messages/${lvl2}`, t, 'mailer');
    expect(ok.status).toBe(200);
    expect(ok.body.text).toBe('Body of two');
    const above = await hostApi('GET', `/mail/messages/${lvl3}`, t, 'mailer');
    expect(above.status).toBe(403);
    expect(above.body.code).toBe('protection_level');
    expect((await hostApi('GET', `/mail/messages/${bobsMail}`, t, 'mailer')).status).toBe(404);
  });

  test('accounts: the user\'s mailboxes and the connected inbox', async () => {
    const res = await hostApi('GET', '/mail/accounts', await token(), 'mailer');
    expect(res.status).toBe(200);
    expect(res.body.accounts).toEqual([{ id: ALICE_ACCOUNT, label: 'Work', address: 'alice@example.com', canSend: true }]);
    expect(res.body.inbox).toEqual({ provider: 'google', protectionLevel: 4 });
  });

  test('the module off, or the user\'s rule denying it, refuses', async () => {
    fx.toolsOff.add('mail');
    const off = await hostApi('GET', '/mail/messages', await token(), 'mailer');
    expect(off.status).toBe(404);
    expect(off.body.code).toBe('module_off');
    fx.toolsOff.clear();
    fx.denied.add('mail.read');
    const denied = await hostApi('GET', `/mail/messages/${lvl1}`, await token(), 'mailer');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('denied_by_rule');
  });

  test('a token without the scope is refused', async () => {
    const res = await hostApi('GET', '/mail/messages', await token({ scopes: ['calendar:read'] }), 'mailer');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('scope_missing');
  });
});

describe('mail:read (connected inbox)', () => {
  test('counts as level 4: refused below it, read at it; only limit and cursor', async () => {
    const below = await hostApi('GET', '/mail/messages?source=inbox', await token({ maxProtection: 3 }), 'mailer');
    expect(below.status).toBe(403);
    expect(below.body.code).toBe('protection_level');
    const sessionId = `sess-${rand(4)}`;
    const ok = await hostApi('GET', '/mail/messages?source=inbox&limit=5&cursor=p1', await token({ sessionId }), 'mailer');
    expect(ok.status).toBe(200);
    expect(ok.body.messages[0]).toMatchObject({ id: 'g1', source: 'inbox', provider: 'google', protectionLevel: 4 });
    expect(ok.body.next).toBe('p2');
    expect(fx.calls.find((c) => c.fn === 'getInbox')?.args).toEqual([ALICE.id, 5, 'p1']);
    const { sessionProtectionLevel } = await import('@/core/protection/session-level');
    expect(sessionProtectionLevel(sessionId)).toBe(4);
    expect((await hostApi('GET', '/mail/messages?source=inbox&q=x', await token(), 'mailer')).status).toBe(400);
  });

  test('reads a message by a provider id, encoded into the path; refuses an id that is not one', async () => {
    const ok = await hostApi('GET', '/mail/messages/AAMk-ab_c=?source=inbox', await token(), 'mailer');
    expect(ok.status).toBe(200);
    expect(ok.body.text).toBe('Inbox body');
    expect(fx.calls.find((c) => c.fn === 'getMessage')?.args).toEqual([ALICE.id, 'google', 'AAMk-ab_c%3D']);
    const bad = await hostApi('GET', '/mail/messages/a.b?source=inbox', await token(), 'mailer');
    expect(bad.status).toBe(404);
    expect(fx.calls.filter((c) => c.fn === 'getMessage')).toHaveLength(1);
  });

  test('nothing connected, or the Inbox module off', async () => {
    fx.inbox = null;
    const none = await hostApi('GET', '/mail/messages?source=inbox', await token(), 'mailer');
    expect(none.body.code).toBe('not_connected');
    fx.inbox = 'google';
    fx.modulesOff.add('inbox');
    expect((await hostApi('GET', '/mail/messages?source=inbox', await token(), 'mailer')).body.code).toBe('module_off');
  });
});

describe('mail:draft', () => {
  test('a new draft is the user\'s, marked with the package, at least at the level the call read', async () => {
    const t = await token({ readLevel: 3, maxProtection: 4 });
    const res = await hostApi('POST', '/mail/drafts', t, 'mailer', { source: 'mail', accountId: ALICE_ACCOUNT, to: 'Jane <jane@example.com>', subject: 'Note', body: 'Hello Jane' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'mail', protectionLevel: 3 });
    const [row] = await query(`SELECT status, protection_level, plugin_source, author_id, to_addresses FROM mail_messages WHERE id = '${res.body.id}'`);
    expect(row).toMatchObject({ status: 'draft', protection_level: 3, author_id: ALICE.id });
    expect(typeof row.plugin_source === 'string' ? JSON.parse(row.plugin_source) : row.plugin_source).toEqual({ plugin: 'mailer', tool: 'mail_tool' });
    const items = await query(`SELECT * FROM plugin_items WHERE item_id = '${res.body.id}'`);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ package_name: 'mailer', user_id: ALICE.id, kind: 'mail_draft', provider: 'mail' });
    // The account's default (2) is the floor.
    const low = await hostApi('POST', '/mail/drafts', await token(), 'mailer', { source: 'mail', accountId: ALICE_ACCOUNT, to: 'jane@example.com', body: 'x' });
    expect(low.body.protectionLevel).toBe(2);
  });

  test('another user\'s account is not found; a bad recipient is refused', async () => {
    const t = await token();
    expect((await hostApi('POST', '/mail/drafts', t, 'mailer', { source: 'mail', accountId: BOB_ACCOUNT, to: 'a@example.com', body: 'x' })).status).toBe(400);
    const bad = await hostApi('POST', '/mail/drafts', t, 'mailer', { source: 'mail', accountId: ALICE_ACCOUNT, to: 'not an address', body: 'x' });
    expect(bad.status).toBe(400);
    expect(await query(`SELECT id FROM mail_messages WHERE account_id = '${BOB_ACCOUNT}' AND status = 'draft'`)).toHaveLength(0);
  });

  test('a reply to a message above maxProtection is refused; within it, it quotes and raises the call', async () => {
    const above = await hostApi('POST', '/mail/drafts', await token({ maxProtection: 2 }), 'mailer', { source: 'mail', replyTo: lvl3, body: 'Thanks' });
    expect(above.status).toBe(403);
    expect(above.body.code).toBe('protection_level');
    const ok = await hostApi('POST', '/mail/drafts', await token({ maxProtection: 2 }), 'mailer', { source: 'mail', replyTo: lvl2, body: 'Thanks' });
    expect(ok.status).toBe(200);
    const [row] = await query(`SELECT subject, in_reply_to, protection_level FROM mail_messages WHERE id = '${ok.body.id}'`);
    expect(row.subject).toBe('Re: two');
    expect(row.protection_level).toBe(2);
  });

  test('a package changes only its own drafts, within maxProtection; its level only rises', async () => {
    const own = await hostApi('POST', '/mail/drafts', await token(), 'mailer', { source: 'mail', accountId: ALICE_ACCOUNT, to: 'jane@example.com', body: 'v1' });
    const changed = await hostApi('PUT', `/mail/drafts/${own.body.id}`, await token({ readLevel: 3 }), 'mailer', { body: 'v2' });
    expect(changed.status).toBe(200);
    expect(changed.body.protectionLevel).toBe(3);
    const [row] = await query(`SELECT body_text, protection_level FROM mail_messages WHERE id = '${own.body.id}'`);
    expect(row).toMatchObject({ body_text: 'v2', protection_level: 3 });
    // Another package, or the same package for another user's call, or a draft the user wrote: not its own.
    expect((await hostApi('PUT', `/mail/drafts/${own.body.id}`, await token({}, 'other'), 'other', { body: 'x' })).body.code).toBe('not_created_by_plugin');
    const [userDraft] = await query<{ id: string }>(`INSERT INTO mail_messages (account_id, user_id, status, subject, body_text) VALUES ('${ALICE_ACCOUNT}', '${ALICE.id}', 'draft', 'mine', 'x') RETURNING id`);
    expect((await hostApi('PUT', `/mail/drafts/${userDraft.id}`, await token(), 'mailer', { body: 'x' })).body.code).toBe('not_created_by_plugin');
    // Above maxProtection now (level 3): refused.
    expect((await hostApi('PUT', `/mail/drafts/${own.body.id}`, await token({ maxProtection: 2 }), 'mailer', { body: 'v3' })).body.code).toBe('protection_level');
  });

  test('inbox drafts: a reply by the provider\'s id, or a new message', async () => {
    const reply = await hostApi('POST', '/mail/drafts', await token(), 'mailer', { source: 'inbox', replyTo: 'g1', body: 'Thanks' });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ id: 'reply-draft-1', source: 'inbox', provider: 'google', protectionLevel: 4 });
    expect(fx.calls.find((c) => c.fn === 'saveReplyDraft')?.args).toEqual([ALICE.id, 'google', 'g1', 'Thanks']);
    const fresh = await hostApi('POST', '/mail/drafts', await token(), 'mailer', { source: 'inbox', to: ['a@example.com', 'b@example.com'], subject: 'Hi', body: 'Hello' });
    expect(fresh.status).toBe(200);
    const call = fx.calls.find((c) => c.fn === 'gmailApi');
    expect(call?.args.slice(1, 3)).toEqual(['POST', '/drafts']);
    expect((await hostApi('POST', '/mail/drafts', await token(), 'mailer', { source: 'inbox', replyTo: '../x', body: 'x' })).status).toBe(404);
  });
});

describe('mail:send', () => {
  test('refused while the call holds data above what the package may carry out', async () => {
    const res = await hostApi('POST', '/mail/send', await token({ maxProtection: 1, readLevel: 2 }), 'mailer', { source: 'mail', accountId: ALICE_ACCOUNT, to: 'jane@example.com', body: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('read_level');
    expect(fx.calls.some((c) => c.fn === 'sendDraft')).toBe(false);
    const inbox = await hostApi('POST', '/mail/send', await token({ maxProtection: 1, readLevel: 3 }), 'mailer', { source: 'inbox', to: 'jane@example.com', body: 'x' });
    expect(inbox.body.code).toBe('read_level');
    expect(fx.calls.some((c) => c.fn === 'sendReply')).toBe(false);
  });

  test('a reply that quotes more than the package may carry out is not sent', async () => {
    const low = await hostApi('POST', '/mail/send', await token({ maxProtection: 1 }), 'mailer', { source: 'mail', replyTo: lvl2, body: 'Thanks' });
    expect(low.body.code).toBe('protection_level');
    const res = await hostApi('POST', '/mail/send', await token({ maxProtection: 2 }), 'mailer', { source: 'mail', replyTo: lvl2, body: 'Thanks' });
    expect(res.status).toBe(200);
    // What the package read for this user stays with it: a later call that may carry out only level 1 does not send.
    const after = await hostApi('POST', '/mail/send', await token({ maxProtection: 1 }), 'mailer', { source: 'mail', accountId: ALICE_ACCOUNT, to: 'a@example.com', body: 'x' });
    expect(after.body.code).toBe('read_level');
    expect(fx.calls.filter((c) => c.fn === 'sendDraft')).toHaveLength(1);
  });

  test('composes and sends as the user; sends its own draft, no other', async () => {
    const t = await token({ maxProtection: 2 });
    const now = await hostApi('POST', '/mail/send', t, 'mailer', { source: 'mail', accountId: ALICE_ACCOUNT, to: 'jane@example.com', subject: 'S', body: 'B' });
    expect(now.status).toBe(200);
    expect(fx.calls.filter((c) => c.fn === 'sendDraft').map((c) => c.args[0])).toEqual([now.body.id]);
    // Sent: no longer the package's to change.
    expect(await query(`SELECT * FROM plugin_items WHERE item_id = '${now.body.id}'`)).toHaveLength(0);
    const draft = await hostApi('POST', '/mail/drafts', t, 'mailer', { source: 'mail', accountId: ALICE_ACCOUNT, to: 'jane@example.com', body: 'later' });
    expect((await hostApi('POST', `/mail/drafts/${draft.body.id}/send`, t, 'mailer')).status).toBe(200);
    const [userDraft] = await query<{ id: string }>(`INSERT INTO mail_messages (account_id, user_id, status, subject, body_text, to_addresses) VALUES ('${ALICE_ACCOUNT}', '${ALICE.id}', 'draft', 'mine', 'x', '[{"address":"a@example.com"}]') RETURNING id`);
    expect((await hostApi('POST', `/mail/drafts/${userDraft.id}/send`, t, 'mailer')).body.code).toBe('not_created_by_plugin');
  });

  test('the inbox sends to exactly one recipient', async () => {
    const two = await hostApi('POST', '/mail/send', await token({ maxProtection: 1 }), 'mailer', { source: 'inbox', to: 'a@example.com, b@example.com', body: 'x' });
    expect(two.status).toBe(400);
    const one = await hostApi('POST', '/mail/send', await token({ maxProtection: 1 }), 'mailer', { source: 'inbox', to: 'a@example.com', subject: 'Hi', body: 'Hello' });
    expect(one.status).toBe(200);
    expect(fx.calls.find((c) => c.fn === 'sendReply')?.args).toEqual([ALICE.id, 'google', { to: 'a@example.com', subject: 'Hi', body: 'Hello' }]);
  });

  test('the user\'s rule denying the provider\'s send refuses', async () => {
    fx.denied.add('google-workspace.email_send');
    const res = await hostApi('POST', '/mail/send', await token({ maxProtection: 1 }), 'mailer', { source: 'inbox', to: 'a@example.com', body: 'x' });
    expect(res.body.code).toBe('denied_by_rule');
  });

  test('audited, one row per request', async () => {
    const before = (await hostAudit('mail.send')).length;
    await hostApi('POST', '/mail/send', await token({ maxProtection: 1, readLevel: 2 }), 'mailer', { source: 'mail', accountId: ALICE_ACCOUNT, to: 'jane@example.com', body: 'x' });
    const rows = await hostAudit('mail.send');
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({ status: 403, code: 'read_level', scope: 'mail:send', tool: 'mail_tool' });
  });
});

describe('calendar', () => {
  const event = { provider: 'google', title: 'Focus', start: '2026-11-10T09:00:00Z', end: '2026-11-10T10:00:00Z', allDay: false };
  const window = '?from=2026-11-01T00:00:00Z&to=2026-11-30T00:00:00Z';

  test('read at the admin\'s level: refused above maxProtection, raises the session', async () => {
    const { getConfig } = await import('@/config');
    const plugins = getConfig().plugins as { calendarProtectionLevel: number };
    expect(plugins.calendarProtectionLevel).toBe(3);
    const below = await hostApi('GET', `/calendar/events${window}`, await token({ maxProtection: 2 }), 'mailer');
    expect(below.status).toBe(403);
    expect(below.body.code).toBe('protection_level');
    const sessionId = `sess-${rand(4)}`;
    const ok = await hostApi('GET', `/calendar/events${window}`, await token({ maxProtection: 3, sessionId }), 'mailer');
    expect(ok.status).toBe(200);
    expect(ok.body.events[0]).toMatchObject({ id: 'e1', protectionLevel: 3 });
    const { sessionProtectionLevel } = await import('@/core/protection/session-level');
    expect(sessionProtectionLevel(sessionId)).toBe(3);
    // An admin lowering the level lets the package read at it.
    plugins.calendarProtectionLevel = 1;
    try {
      expect((await hostApi('GET', `/calendar/events${window}`, await token({ maxProtection: 1 }), 'mailer')).status).toBe(200);
    } finally {
      plugins.calendarProtectionLevel = 3;
    }
    expect((await hostApi('GET', '/calendar/events?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z', await token(), 'mailer')).status).toBe(400);
  });

  test('a write from a call above the calendar\'s level is refused', async () => {
    const res = await hostApi('POST', '/calendar/events', await token({ readLevel: 4 }), 'mailer', event);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('read_level');
    expect(fx.calls.some((c) => c.fn === 'writeCalendarEvent')).toBe(false);
  });

  test('creates events; changes only its own; another publisher or an uninstall ends that', async () => {
    const created = await hostApi('POST', '/calendar/events', await token(), 'mailer', event);
    expect(created.status).toBe(200);
    const id = created.body.id as string;
    expect((await hostApi('PUT', `/calendar/events/${id}`, await token(), 'mailer', { ...event, title: 'Deep work' })).status).toBe(200);
    expect(fx.calls.filter((c) => c.fn === 'writeCalendarEvent').at(-1)?.args[3]).toBe(id);
    // Not another package's, not on another provider, not another user's.
    expect((await hostApi('PUT', `/calendar/events/${id}`, await token({}, 'other'), 'other', event)).body.code).toBe('not_created_by_plugin');
    expect((await hostApi('PUT', `/calendar/events/${id}`, await token(), 'mailer', { ...event, provider: 'microsoft' })).body.code).toBe('not_created_by_plugin');
    expect((await hostApi('PUT', `/calendar/events/${id}`, await token({ userId: BOB.id }), 'mailer', event)).body.code).toBe('not_created_by_plugin');
    expect((await hostApi('PUT', '/calendar/events/someone-elses', await token(), 'mailer', event)).body.code).toBe('not_created_by_plugin');
    // Another publisher takes the package over: it changes nothing it did not create itself.
    const { pluginItemsRepository } = await import('@/db/repositories/plugin-items-repository');
    expect(await pluginItemsRepository.forgetPackage('mailer')).toBeGreaterThan(0);
    expect((await hostApi('PUT', `/calendar/events/${id}`, await token(), 'mailer', event)).body.code).toBe('not_created_by_plugin');
    // Uninstalling deletes its rows.
    await hostApi('POST', '/calendar/events', await token({}, 'other'), 'other', event);
    expect(await query(`SELECT * FROM plugin_items WHERE package_name = 'other'`)).toHaveLength(1);
    await query(`DELETE FROM plugin_packages WHERE name = 'other'`);
    expect(await query(`SELECT * FROM plugin_items WHERE package_name = 'other'`)).toHaveLength(0);
    await query(`INSERT INTO plugin_packages (name, version, manifest, enabled) VALUES ('other', '1.0.0', '{"name":"other","version":"1.0.0"}', true)`);
  });

  test('a bad event is refused before the provider; the user\'s rule on the provider refuses', async () => {
    const bad = await hostApi('POST', '/calendar/events', await token(), 'mailer', { ...event, end: event.start });
    expect(bad.status).toBe(400);
    fx.denied.add('microsoft365.calendar_write');
    const denied = await hostApi('POST', '/calendar/events', await token(), 'mailer', { ...event, provider: 'microsoft' });
    expect(denied.body.code).toBe('denied_by_rule');
    fx.modulesOff.add('inbox');
    expect((await hostApi('GET', `/calendar/events${window}`, await token(), 'mailer')).body.code).toBe('module_off');
  });
});
