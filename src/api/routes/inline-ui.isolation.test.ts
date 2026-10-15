/**
 * Interactive answers on the server (docs/plans/inline-ui-spec.md): storing
 * the `octi-ui` fences of a reply, and who may read a stored block.
 *
 *   - extraction stores a block and leaves a marker, refuses a cut-off or
 *     oversized one with a visible notice, keeps nothing for a session that
 *     may not store content, records the session's flow label, and is
 *     idempotent;
 *   - a block is readable exactly when its conversation's messages are: the
 *     chat's owner (and an admin, as for the messages), every member of a
 *     room; anyone else gets 404; a block id under another session's id is
 *     not found;
 *   - every member of a room reads the room's blocks; a stranger gets 404;
 *   - responses are never cached;
 *   - reports and provenance only name blocks of the session;
 *   - the `source` tool returns a block of the agent's own session only;
 *   - saving a block as an artifact: the owner's own chat only, never a
 *     tainted block, private or workspace only; the copy reaches no network,
 *     its script is bundled after the `octi` shim.
 *
 * Driven through the real `createServer()`, backed by ephemeral PGlite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const ownerId = randomUUID();
const memberId = randomUUID();
const strangerId = randomUUID();

type App = { handle(request: Request): Promise<Response> };
let app: App;
const tokens: Record<string, string> = {};
let chatId: string;
let otherChatId: string;
let roomId: string;
let spaceId: string;

async function get(who: string, path: string): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${tokens[who]}` } }));
}

async function post(who: string, path: string, body: unknown): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

const fence = (title: string, body: string) => `Here it is.\n\n\`\`\`octi-ui title="${title}" height=240\n${body}\n\`\`\`\n\nDone.`;
const ID_RE = /\[\[octi-ui:([0-9a-f-]{36})\|/;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-inline-ui-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { seedUsers, seedSession } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: ownerId, username: 'iu-owner' },
    { id: memberId, username: 'iu-member', isAdmin: true },
    { id: strangerId, username: 'iu-stranger' },
  ]);
  const { getSessionManager } = await import('@/security/auth/session');
  for (const [name, id] of [['owner', ownerId], ['member', memberId], ['stranger', strangerId]]) {
    tokens[name] = (await getSessionManager().create(id)).token;
  }
  const { createServer } = await import('@/api/server');
  app = createServer();
  chatId = (await seedSession({ userId: ownerId })).id;
  otherChatId = (await seedSession({ userId: ownerId })).id;
  const { spaceWith } = await import('@/test-helpers/space-fixtures');
  spaceId = await spaceWith(ownerId, [[memberId, 'viewer']], 'Interactive');
  const { queryRaw } = await import('@/db/postgres');
  roomId = (await queryRaw(`SELECT id FROM sessions WHERE workspace_id = $1 AND kind = 'room' LIMIT 1`, [spaceId])).rows[0].id;
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function store(sessionId: string, text: string, contentStorageOff = false) {
  const { storeInlineUiBlocks } = await import('@/core/inline-ui/extract');
  return storeInlineUiBlocks(text, { sessionId, agentId: 'agent-1', requesterId: ownerId, contentStorageOff });
}

describe('extraction', () => {
  test('stores a block and leaves a marker; idempotent on the result', async () => {
    const out = await store(chatId, fence('Loan calculator', '<style>p{color:red}</style><p id="r">0</p><script>document.getElementById("r").textContent = "1";</script>'));
    expect(out.stored).toHaveLength(1);
    expect(out.text).toMatch(/^Here it is\.\n\n\[\[octi-ui:[0-9a-f-]{36}\|Loan calculator\]\]\n\nDone\.$/);
    const { inlineUiRepository } = await import('@/db/repositories/inline-ui-repository');
    const block = await inlineUiRepository.getInSession(out.stored[0], chatId);
    expect(block).toMatchObject({ title: 'Loan calculator', heightHint: 240, css: 'p{color:red}', html: '<p id="r">0</p>', scripts: true, tainted: false, risk: 'normal' });
    const again = await store(chatId, out.text);
    expect(again).toEqual({ text: out.text, stored: [], refused: 0 });
  });

  test('refuses a cut-off block and a script that does not parse, in place and visibly', async () => {
    const cut = await store(chatId, 'Intro\n```octi-ui title="Cut"\n<div>half');
    expect(cut.stored).toEqual([]);
    expect(cut.text).toContain('Interactive answer “Cut” could not be shown: the block was cut off');
    const bad = await store(chatId, fence('Bad', '<p>x</p><script>function (</script>'));
    expect(bad.text).toContain('could not be shown: the script does not parse');
  });

  test('keeps nothing for a session that may not store content outside its rows', async () => {
    const out = await store(chatId, fence('Private', '<p>x</p>'), true);
    expect(out.stored).toEqual([]);
    expect(out.text).toContain('is not kept in this conversation');
  });

  test('records the session flow label: tainted, and high risk after a secret read', async () => {
    const { observeFlow } = await import('@/security/flow-guard');
    const tainted = (await seedSessionFor(ownerId));
    observeFlow(tainted, { toolId: 'websearch', action: 'search', args: { query: 'x' } });
    const out = await store(tainted, fence('Web', '<p>x</p>'));
    const { inlineUiRepository } = await import('@/db/repositories/inline-ui-repository');
    expect(await inlineUiRepository.getInSession(out.stored[0], tainted)).toMatchObject({ tainted: true, risk: 'normal' });
    observeFlow(tainted, { toolId: 'filesystem', action: 'read', args: { path: '/home/me/.ssh/id_rsa' } });
    const secret = await store(tainted, fence('Secret', '<p>x</p>'));
    expect(await inlineUiRepository.getInSession(secret.stored[0], tainted)).toMatchObject({ tainted: true, risk: 'high' });
  });
});

async function seedSessionFor(userId: string): Promise<string> {
  const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
  return (await seedSession({ userId })).id;
}

describe('reading a block (S8)', () => {
  let chatBlock: string;
  let roomBlock: string;

  beforeAll(async () => {
    chatBlock = (await store(chatId, fence('Chat', '<p>chat</p>'))).stored[0];
    roomBlock = (await store(roomId, fence('Room', '<p>room</p>'))).stored[0];
  });

  test('the chat owner reads it, never cached', async () => {
    const res = await get('owner', `/api/sessions/${chatId}/inline-ui/${chatBlock}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).block).toMatchObject({ id: chatBlock, html: '<p>chat</p>', shared: false });
  });

  test('another user gets 404 for a personal chat', async () => {
    expect((await get('stranger', `/api/sessions/${chatId}/inline-ui/${chatBlock}`)).status).toBe(404);
  });

  test('a block is readable exactly when the conversation’s messages are (an admin included)', async () => {
    for (const who of ['owner', 'member', 'stranger']) {
      for (const [session, block] of [[chatId, chatBlock], [roomId, roomBlock]]) {
        const messages = (await get(who, `/api/sessions/${session}/messages`)).status === 200
          || (await get(who, `/api/spaces/${spaceId}/rooms/${session}/messages`)).status === 200;
        const blockStatus = (await get(who, `/api/sessions/${session}/inline-ui/${block}`)).status;
        expect(blockStatus === 200, `${who} ${session === chatId ? 'chat' : 'room'}`).toBe(messages);
      }
    }
  });

  test('a block id under another session id, or a malformed id, is not found', async () => {
    expect((await get('owner', `/api/sessions/${otherChatId}/inline-ui/${chatBlock}`)).status).toBe(404);
    expect((await get('owner', `/api/sessions/${chatId}/inline-ui/not-a-uuid`)).status).toBe(404);
    expect((await get('owner', `/api/sessions/${roomId}/inline-ui/${chatBlock}`)).status).toBe(404);
  });

  test('every member of a room reads its blocks, marked shared; a stranger gets 404', async () => {
    for (const who of ['owner', 'member']) {
      const res = await get(who, `/api/sessions/${roomId}/inline-ui/${roomBlock}`);
      expect(res.status, who).toBe(200);
      expect((await res.json()).block, who).toMatchObject({ id: roomBlock, shared: true });
    }
    expect((await get('stranger', `/api/sessions/${roomId}/inline-ui/${roomBlock}`)).status).toBe(404);
  });

  test('an unauthenticated request is refused', async () => {
    const res = await app.handle(new Request(`http://localhost/api/sessions/${chatId}/inline-ui/${chatBlock}`));
    expect([401, 404]).toContain(res.status);
  });
});

describe('turn notes and the source tool', () => {
  test('reports and provenance keep only blocks of the session, as enum lines', async () => {
    const own = (await store(chatId, fence('Own', '<p>own</p>'))).stored[0];
    const foreign = (await store(otherChatId, fence('Foreign', '<p>f</p>'))).stored[0];
    const { resolveInlineUiTurnNotes } = await import('@/core/inline-ui/turn-input');
    const out = await resolveInlineUiTurnNotes(chatId, {
      reports: [{ id: own, outcome: 'script-error', errorClass: 'TypeError', line: 3 }, { id: foreign, outcome: 'blank' }],
      provenance: { inlineUiId: foreign },
    });
    expect(out.notes).toEqual([`(system note: interactive answer ${own} reported script-error TypeError line 3)`]);
    expect(out.provenanceId).toBeUndefined();
  });

  test('the output guard reads the sources of the blocks a reply shows, of this session only', async () => {
    const own = await store(chatId, fence('Leak', '<p>OWN-SOURCE-TEXT</p>'));
    const foreign = await store(otherChatId, fence('Other', '<p>FOREIGN-SOURCE-TEXT</p>'));
    const { inlineUiGuardText } = await import('@/core/inline-ui/extract');
    const text = await inlineUiGuardText(`${own.text}\n${foreign.text}`, chatId);
    expect(text).toContain('OWN-SOURCE-TEXT');
    expect(text).not.toContain('FOREIGN-SOURCE-TEXT');
    expect(await inlineUiGuardText('no blocks here', chatId)).toBe('no blocks here');
  });

  test('source returns a block of the agent’s own session only, and only where interactive answers are offered', async () => {
    const out = await store(chatId, fence('Source', '<style>a{}</style><p>s</p><script>go()</script>'));
    const id = ID_RE.exec(out.text)?.[1] as string;
    const { inlineUiTool } = await import('@/tools/inline-ui');
    await inlineUiTool.initialize();
    const handler = inlineUiTool.getToolHandlers().find((t) => t.name === 'inline-ui__source');
    expect(handler).toBeDefined();
    const base = { id: 'agent-1', userId: ownerId, root: true, metadata: { inlineUiOffered: true } };
    const result = await handler!.execute({ id }, { ...base, sessionId: chatId } as never) as { body: string };
    expect(result.body).toBe('<style>\na{}\n</style>\n<p>s</p>\n<script>\ngo()\n</script>');
    await expect(handler!.execute({ id }, { ...base, sessionId: otherChatId } as never)).rejects.toThrow(/No interactive answer/);
    await expect(handler!.execute({ id }, { ...base, sessionId: chatId, metadata: {} } as never)).rejects.toThrow(/not available/);
  });
});

describe('saving a block as an artifact (§7)', () => {
  const promote = (who: string, sessionId: string, id: string, body: Record<string, unknown>) =>
    post(who, `/api/sessions/${sessionId}/inline-ui/${id}/promote`, body);

  test('the owner saves a scripted block: a closed, private copy whose script is bundled after the shim', async () => {
    const out = await store(chatId, fence('Tip calculator', '<style>p{color:red}</style><p id="r">0</p><a href="https://docs.example/tips">docs</a><script>document.getElementById("r").textContent = "15%"; octi.prompt("why");</script>'));
    const id = out.stored[0];
    const res = await promote('owner', chatId, id, { title: 'Tip calculator', slug: 'tip-calculator' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.artifact).toMatchObject({ slug: 'tip-calculator', visibility: 'private', network: 'none', type: 'html' });
    expect(body.bridge).toBe(true);
    expect(body.warnings).toEqual([]);

    const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
    const version = (await artifactsRepository.getVersion(body.artifact.currentVersionId))!;
    expect(version.htmlTemplate).toBe('<p id="r">0</p><a data-octi-href="https://docs.example/tips" role="link" tabindex="0">docs</a>');
    expect(version.css).toContain('p{color:red}');
    const { bundleFilePath } = await import('@/core/artifacts/bundler');
    const { readFileSync } = await import('node:fs');
    const bundle = readFileSync(bundleFilePath(body.artifact.id, version.id), 'utf8');
    expect(bundle).toContain('not available here');
    expect(bundle).toContain('15%');
    expect(bundle.indexOf('not available here')).toBeLessThan(bundle.indexOf('15%'));

    const embed = await get('owner', '/__artifacts__/a/tip-calculator/embed');
    expect(embed.status).toBe(200);
    const csp = embed.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain('img-src data: blob:');
    expect(csp).toMatch(/sandbox allow-scripts$/);
    const page = await embed.text();
    expect(page).not.toContain('octipus-artifact-token');
    expect(page).not.toContain('octipus-artifact-client.js');
    expect(page).toContain(`<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>`);
    expect(page).not.toContain('/bundle.js');
  });

  test('a tainted block is refused; so is any visibility beyond workspace', async () => {
    const { observeFlow } = await import('@/security/flow-guard');
    const session = await seedSessionFor(ownerId);
    observeFlow(session, { toolId: 'websearch', action: 'search', args: { query: 'x' } });
    const tainted = (await store(session, fence('Web', '<p>x</p>'))).stored[0];
    const refused = await promote('owner', session, tainted, { title: 'Web', slug: 'web-copy' });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/content from outside/);

    const clean = (await store(chatId, fence('Plain', '<p>x</p>'))).stored[0];
    const pub = await promote('owner', chatId, clean, { title: 'Plain', slug: 'plain-public', visibility: 'public' });
    expect(pub.status).toBeGreaterThanOrEqual(400);
    expect(pub.status).toBeLessThan(500);
    const shared = await promote('owner', chatId, clean, { title: 'Plain', slug: 'plain-shared', visibility: 'workspace' });
    expect(shared.status).toBe(201);
    expect((await shared.json()).artifact.visibility).toBe('workspace');
    const again = await promote('owner', chatId, clean, { title: 'Plain', slug: 'plain-shared' });
    expect(again.status).toBe(409);
  });

  test('only from the caller’s own chat: an admin who may read it, a stranger and a room get 404', async () => {
    const id = (await store(chatId, fence('Mine', '<p>m</p>'))).stored[0];
    expect((await promote('member', chatId, id, { title: 'Mine', slug: 'by-admin' })).status).toBe(404);
    expect((await promote('stranger', chatId, id, { title: 'Mine', slug: 'by-stranger' })).status).toBe(404);
    expect((await promote('owner', otherChatId, id, { title: 'Mine', slug: 'wrong-session' })).status).toBe(404);
    const inRoom = (await store(roomId, fence('Room', '<p>r</p>'))).stored[0];
    expect((await promote('owner', roomId, inRoom, { title: 'Room', slug: 'from-room' })).status).toBe(404);
  });

  test('a bad slug or an empty title is a 400', async () => {
    const id = (await store(chatId, fence('Slug', '<p>s</p>'))).stored[0];
    expect((await promote('owner', chatId, id, { title: 'Slug', slug: 'Not A Slug' })).status).toBe(400);
    expect((await promote('owner', chatId, id, { title: '   ', slug: 'ok-slug' })).status).toBe(400);
  });
});
