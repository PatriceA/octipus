/**
 * Hosted artifact pages treat artifact content as untrusted, through the real
 * server (`createServer`) over embedded PGlite:
 *
 *  - the artifact host serves the hosted pages and nothing else: no `/api`,
 *    no sign-in, no session (credentials sent there are ignored), no cookie;
 *    in subdomain mode an artifact page is never served on the app's host;
 *  - every page carries a policy that keeps it off the app's origin
 *    (`sandbox` without `allow-same-origin`), whichever mode and mount;
 *  - the embed's viewer token opens one artifact's data, read-only, until it
 *    expires or is revoked, and is accepted by no `/api` route.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

// The artifact host, switchable per test (subdomain mode when set).
const hostSetting = vi.hoisted(() => ({ host: '' }));
vi.mock('@/core/artifacts/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/artifacts/settings')>();
  return {
    ...actual,
    resolveArtifactSettings: () => ({ ...actual.resolveArtifactSettings(), host: hostSetting.host, proto: 'https' as const }),
  };
});

const ARTIFACT_HOST = 'artifacts.test';
const userId = randomUUID();
const adminId = randomUUID();
let adminSession: string;
type App = { handle(request: Request): Promise<Response> };
let app: App;
let session: string;

afterEach(() => {
  hostSetting.host = '';
});

function send(method: string, url: string, opts: { host?: string; auth?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.host) headers.host = opts.host;
  if (opts.auth) headers.authorization = opts.auth;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return app.handle(new Request(`http://localhost${url}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }));
}
const asUser = (method: string, url: string, body?: unknown) => send(method, url, { auth: `Bearer ${session}`, body });

async function createArtifact(slug: string, visibility: 'public' | 'workspace' | 'signed' | 'private'): Promise<{ id: string; sourceId: string }> {
  const res = await asUser('POST', '/api/artifacts', { slug, title: `T ${slug}`, type: 'html', visibility, htmlTemplate: '<p data-bind="feed">x</p>' });
  expect(res.status).toBe(201);
  const { artifact } = await res.json();
  const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
  const source = await artifactsRepository.createSource({ artifactId: artifact.id, name: 'feed', kind: 'http', configJson: { url: 'https://example.invalid' }, refreshSeconds: 300, principalId: userId });
  await artifactsRepository.createSnapshot({ sourceId: source.id, payloadJson: { secret: `data-of-${slug}` } });
  return { id: artifact.id, sourceId: source.id };
}

/** The viewer token the embed page carries. */
async function embedToken(path: string, opts: { host?: string; auth?: string } = {}): Promise<string> {
  const res = await send('GET', path, opts);
  expect(res.status).toBe(200);
  const token = /<meta name="octipus-artifact-token" content="([^"]+)">/.exec(await res.text())?.[1];
  expect(token).toBeTruthy();
  return token!.replace(/&amp;/g, '&');
}

let pub: { id: string; sourceId: string };
let ws: { id: string; sourceId: string };
let signed: { id: string; sourceId: string };

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-artifact-hosting-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'hosting-user' }, { id: adminId, username: 'hosting-admin', isAdmin: true }]);
  const { getSessionManager } = await import('@/security/auth/session');
  session = (await getSessionManager().create(userId)).token;
  adminSession = (await getSessionManager().create(adminId)).token;
  const { createServer } = await import('@/api/server');
  app = createServer();
  pub = await createArtifact('pub-board', 'public');
  ws = await createArtifact('ws-board', 'workspace');
  signed = await createArtifact('signed-board', 'signed');
}, 120_000);

describe('the artifact host serves artifact pages and nothing else', () => {
  test('the app API, sign-in and preflights are not reachable there, even with valid credentials', async () => {
    hostSetting.host = ARTIFACT_HOST;
    expect((await send('GET', '/api/artifacts', { host: ARTIFACT_HOST, auth: `Bearer ${session}` })).status).toBe(404);
    expect((await send('GET', `/api/artifacts/${ws.id}/data/feed`, { host: ARTIFACT_HOST, auth: `Bearer ${session}` })).status).toBe(404);
    const login = await send('POST', '/api/auth/login', { host: ARTIFACT_HOST, body: { username: 'hosting-user', password: 'x' } });
    expect(login.status).toBe(404);
    expect(login.headers.get('set-cookie')).toBeNull();
    expect((await send('OPTIONS', '/api/artifacts', { host: ARTIFACT_HOST, headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } })).status).toBe(404);
    expect((await send('GET', '/v1/models', { host: ARTIFACT_HOST, auth: `Bearer ${session}` })).status).toBe(404);
    // The fallback mount belongs to the app host.
    expect((await send('GET', '/__artifacts__/a/pub-board/embed', { host: ARTIFACT_HOST })).status).toBe(404);
  });

  test('a public page is served there, sandboxed, with no cookie', async () => {
    hostSetting.host = ARTIFACT_HOST;
    const res = await send('GET', '/a/pub-board/embed', { host: `${ARTIFACT_HOST}:443` });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toMatch(/; sandbox allow-scripts$/);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('a session sent to the artifact host is ignored: a workspace page is not found there', async () => {
    hostSetting.host = ARTIFACT_HOST;
    expect((await send('GET', '/a/ws-board/embed', { host: ARTIFACT_HOST, auth: `Bearer ${session}` })).status).toBe(404);
    expect((await send('GET', '/a/ws-board/embed', { host: ARTIFACT_HOST, headers: { cookie: `session_token=${session}` } })).status).toBe(404);
  });

  test('in subdomain mode the root pages are not served on the app host; the app-host fallback still is', async () => {
    hostSetting.host = ARTIFACT_HOST;
    expect((await send('GET', '/a/pub-board/embed')).status).toBe(404);
    expect((await send('GET', '/a/pub-board')).status).toBe(404);
    expect((await send('GET', '/a/pub-board/embed', { host: `evil-${ARTIFACT_HOST}` })).status).toBe(404);
    const fallback = await asUser('GET', '/__artifacts__/a/ws-board/embed');
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get('content-security-policy')).toMatch(/; sandbox allow-scripts$/);
  });

  test('an artifact-host socket admits artifact viewers only', async () => {
    hostSetting.host = ARTIFACT_HOST;
    const { getGatewayHub } = await import('@/core/gateway/hub');
    const cm = getGatewayHub().connectionManager;
    const frames: Array<Record<string, unknown>> = [];
    const socket = { send: (f: string) => frames.push(JSON.parse(f)), close: vi.fn(), readyState: 1 };
    const id = cm.handleOpen(socket as never, '127.0.0.9', undefined, { artifactViewerOnly: true })!;
    await cm.handleMessage(id, JSON.stringify({ type: 'auth', method: 'session_token', credentials: { token: session }, clientType: 'webchat' }));
    expect(frames.at(-1)).toEqual({ type: 'auth_error', reason: 'Only artifact viewers sign in on the artifact host' });
    expect(socket.close).toHaveBeenCalledWith(4001, 'Only artifact viewers sign in on the artifact host');
  });
});

describe('every artifact response keeps the content off the app origin', () => {
  test('path-prefix embed: sandboxed without allow-same-origin, framed by self only, not sniffed, not cached, no referrer', async () => {
    const res = await asUser('GET', '/__artifacts__/a/ws-board/embed');
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toMatch(/; sandbox allow-scripts$/);
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('the Host header is never reflected into a page', async () => {
    const res = await send('GET', '/__artifacts__/a/pub-board', { host: 'evil.example' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('evil.example');
    expect(html).toContain('src="/__artifacts__/a/pub-board/embed"');
    const embed = await send('GET', '/__artifacts__/a/pub-board/embed', { host: 'evil.example' });
    expect(await embed.text()).not.toContain('evil.example');
  });

  test('the outer page runs no script and frames only its own embed', async () => {
    const res = await send('GET', '/__artifacts__/a/pub-board');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-src 'self'");
    expect(csp).not.toContain('script-src');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await res.text()).toContain('sandbox="allow-scripts"');
  });

  test('an export is an inert download', async () => {
    const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
    await artifactsRepository.createExport({ artifactId: pub.id, exportId: 'json', toolId: 'art_export_json', bindJson: { data: 'feed' }, paramsJson: {} });
    const res = await send('GET', '/__artifacts__/a/pub-board/export/json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('content-security-policy')).toMatch(/sandbox$/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('an embed origin that would add a CSP directive is refused by the API', async () => {
    const res = await asUser('PUT', `/api/artifacts/${pub.id}`, { allowedEmbedOrigins: ['https://ok.example; sandbox allow-scripts allow-same-origin'] });
    expect(res.status).toBe(400);
    expect((await asUser('PUT', `/api/artifacts/${pub.id}`, { allowedEmbedOrigins: ['https://ok.example'] })).status).toBe(200);
    const embed = await send('GET', '/__artifacts__/a/pub-board/embed');
    expect(embed.headers.get('content-security-policy')).toContain("frame-ancestors 'self' https://ok.example;");
  });
});

describe('the embed viewer token: one artifact, read-only, expiring, revocable', () => {
  const data = (slug: string, token: string, opts: { host?: string } = {}) =>
    send('GET', `/__artifacts__/a/${slug}/data/feed?vt=${encodeURIComponent(token)}`, opts);

  test('it reads its artifact\'s data from the embed\'s data route, cross-origin, without credentials', async () => {
    const token = await embedToken('/__artifacts__/a/ws-board/embed', { auth: `Bearer ${session}` });
    const res = await data('ws-board', token);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect((await res.json()).payload).toEqual({ secret: 'data-of-ws-board' });
    // The same route on the artifact host (subdomain mode).
    hostSetting.host = ARTIFACT_HOST;
    const onHost = await send('GET', `/a/ws-board/data/feed?vt=${encodeURIComponent(token)}`, { host: ARTIFACT_HOST });
    expect(onHost.status).toBe(200);
  });

  test('it opens no other artifact, no write, and no /api route', async () => {
    const token = await embedToken('/__artifacts__/a/ws-board/embed', { auth: `Bearer ${session}` });
    // Another artifact's slug.
    expect((await data('pub-board', token)).status).toBe(401);
    // The session-only REST read, in every way a token could be presented.
    expect((await send('GET', `/api/artifacts/${ws.id}/data/feed`, { auth: `Bearer ${token}` })).status).toBe(401);
    expect((await send('GET', `/api/artifacts/${ws.id}/data/feed`, { auth: `ArtifactToken ${token}` })).status).toBe(401);
    expect((await send('GET', `/api/artifacts/${ws.id}/data/feed?vt=${encodeURIComponent(token)}`)).status).toBe(401);
    // Writes and other routes.
    expect((await send('POST', `/api/artifacts/${ws.id}/refresh`, { auth: `Bearer ${token}` })).status).toBe(401);
    expect((await send('PUT', `/api/artifacts/${ws.id}`, { auth: `Bearer ${token}`, body: { visibility: 'public' } })).status).toBe(401);
    expect((await send('GET', '/api/sessions', { auth: `Bearer ${token}` })).status).toBe(401);
    expect((await send('POST', `/__artifacts__/a/ws-board/data/feed?vt=${encodeURIComponent(token)}`)).status).toBe(404);
    // A session does not stand in for the token on the data route.
    expect((await asUser('GET', '/__artifacts__/a/ws-board/data/feed')).status).toBe(401);
  });

  test('a forged, widened or expired token is refused', async () => {
    const { signArtifactToken } = await import('@/core/artifacts/token');
    const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
    const wid = (await artifactsRepository.getById(ws.id))!.workspaceId;
    const now = Math.floor(Date.now() / 1000);
    const expired = signArtifactToken({ aid: ws.id, wid, scope: 'view', iat: now - 600, exp: now - 1 });
    expect((await data('ws-board', expired)).status).toBe(401);
    // Signed for the right artifact but another workspace.
    const elsewhere = signArtifactToken({ aid: ws.id, wid: randomUUID(), scope: 'view', iat: now, exp: now + 60 });
    expect((await data('ws-board', elsewhere)).status).toBe(401);
    // A payload edited to claim more (or another artifact) fails its signature.
    const good = signArtifactToken({ aid: ws.id, wid, scope: 'view', iat: now, exp: now + 60 });
    const [h, , s] = good.split('.');
    const widened = Buffer.from(JSON.stringify({ aid: pub.id, aud: `artifact:${pub.id}`, wid, scope: 'view', iat: now, exp: now + 3600 })).toString('base64url');
    expect((await data('pub-board', `${h}.${widened}.${s}`)).status).toBe(401);
    expect((await data('ws-board', 'not-a-token')).status).toBe(401);
    expect((await data('ws-board', good)).status).toBe(200);
  });

  test('a visibility change revokes the tokens issued before it', async () => {
    const token = await embedToken('/__artifacts__/a/pub-board/embed');
    expect((await data('pub-board', token)).status).toBe(200);
    // `iat` is whole seconds and the cutoff refuses iat <= cutoff.
    expect((await asUser('PUT', `/api/artifacts/${pub.id}`, { visibility: 'workspace' })).status).toBe(200);
    expect((await data('pub-board', token)).status).toBe(401);
    await asUser('PUT', `/api/artifacts/${pub.id}`, { visibility: 'public' });
  });

  test('revoking the share link a page was opened with ends its token', async () => {
    const minted = await (await asUser('POST', `/api/artifacts/${signed.id}/share-links`, { ttlSeconds: 600 })).json();
    // Anonymous visitor with the link.
    const token = await embedToken(`/__artifacts__/a/signed-board/embed?t=${encodeURIComponent(minted.token)}`);
    const { verifyArtifactToken } = await import('@/core/artifacts/token');
    expect(verifyArtifactToken(token, { aid: signed.id })?.slid).toBe(minted.id);
    expect((await data('signed-board', token)).status).toBe(200);
    expect((await asUser('DELETE', `/api/artifacts/${signed.id}/share-links/${minted.id}`)).status).toBe(200);
    expect((await data('signed-board', token)).status).toBe(401);
    // And the link no longer opens the page.
    expect((await send('GET', `/__artifacts__/a/signed-board/embed?t=${encodeURIComponent(minted.token)}`)).status).toBe(404);
  });

  test('a deleted artifact\'s token opens nothing', async () => {
    const doomed = await createArtifact('doomed-board', 'public');
    const token = await embedToken('/__artifacts__/a/doomed-board/embed');
    expect((await asUser('DELETE', `/api/artifacts/${doomed.id}`)).status).toBe(200);
    expect((await data('doomed-board', token)).status).toBe(401);
  });
});

describe('path spellings cannot move an artifact page off its sandbox', () => {
  /** A response for artifact bytes is either refused, or carries exactly the embed's sandboxing policy. */
  async function expectNoUnsandboxedPage(res: Response, label: string) {
    if (res.status >= 300) return;
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp.match(/default-src/g), label).toHaveLength(1);
    expect(csp, label).toMatch(/; sandbox allow-scripts$/);
    expect(csp, label).not.toContain('allow-same-origin');
  }

  const variants = (prefix: string) => [
    `/%61/pub-board/embed`,
    `/%41/pub-board/embed`,
    `${prefix}/a/pub-board/%65mbed`,
    `${prefix}/a/pub-board/%65MBED`,
    `/%2561/pub-board/embed`,
    `${prefix}/a/%70ub-board/embed`,
    `//a/pub-board/embed`,
    `${prefix}//a/pub-board/embed`,
    `/./a/pub-board/embed`,
    `${prefix}/a/./pub-board/embed`,
    `${prefix}/a/pub-board/embed;`,
    `${prefix}/a/pub-board;/embed`,
    `${prefix}/a/pub-board/embed/`,
    `/__%61rtifacts__/a/pub-board/embed`,
    `/__artifacts__/%61/pub-board/embed`,
    `/__%41RTIFACTS__/a/pub-board/embed`,
    `${prefix}/a/pub-board/embed%`,
    `${prefix}/a/pub-board/embed%zz`,
  ];

  test('a percent-encoded unreserved character or a broken escape is refused before routing', async () => {
    for (const path of ['/%61/pub-board/embed', '/__%61rtifacts__/a/pub-board/embed', '/%61pi/sessions', '/api/%73essions', '/a/x%zz']) {
      expect((await send('GET', path)).status, path).toBe(400);
    }
    // A reserved escape in a parameter is still fine.
    expect((await send('GET', '/__artifacts__/a/pub-board/data/a%20b?vt=x')).status).toBe(401);
  });

  for (const mode of ['path-prefix', 'subdomain'] as const) {
    for (const where of ['app host', 'artifact host'] as const) {
      test(`${mode} mode, ${where}: every spelling is refused or sandboxed`, async () => {
        hostSetting.host = mode === 'subdomain' ? ARTIFACT_HOST : '';
        const host = where === 'artifact host' ? ARTIFACT_HOST : undefined;
        for (const path of [...variants('/__artifacts__'), ...variants('')]) {
          const res = await send('GET', path, { host });
          await expectNoUnsandboxedPage(res, `${mode} ${where} ${path}`);
          if (mode === 'subdomain' && where === 'app host' && !path.includes('artifacts__')) {
            expect(res.status, `root page on the app host: ${path}`).not.toBe(200);
          }
        }
      });
    }
  }

  test('no artifact script is served as a file from any origin', async () => {
    for (const path of ['/__artifacts__/a/pub-board/bundle.js', '/a/pub-board/bundle.js']) {
      expect((await send('GET', path)).status, path).toBe(404);
    }
  });

  test('a template cannot assemble a script tag around an expression', async () => {
    const res = await asUser('POST', '/api/artifacts', {
      slug: 'split-tag',
      title: 'Split',
      type: 'html',
      visibility: 'public',
      htmlTemplate: '<scr{{data.none}}ipt src="/x.js"></scr{{data.none}}ipt><img/onerror{{data.none}}=alert(1) src=x>',
    });
    expect(res.status).toBe(201);
    const html = await (await send('GET', '/__artifacts__/a/split-tag/embed')).text();
    expect(html).not.toMatch(/<script src="(?!\/octipus-artifact-client\.js")/);
    expect(html).not.toMatch(/onerror/i);
  });
});

describe('the artifact host can never shadow the app', () => {
  test('saving the host the app is used at as artifacts.host is refused', async () => {
    for (const [path, body] of [
      ['/api/settings/artifacts.host', { value: 'localhost' }],
      ['/api/settings/artifacts.host', { value: 'https://LOCALHOST/' }],
    ] as const) {
      const res = await send('PUT', path, { auth: `Bearer ${adminSession}`, body });
      expect((await res.json()).error, JSON.stringify(body)).toMatch(/host of its own/);
    }
    const batch = await send('PUT', '/api/settings/batch', { auth: `Bearer ${adminSession}`, body: { settings: { 'artifacts.host': 'localhost' } } });
    expect((await batch.json()).errors?.['artifacts.host']).toMatch(/host of its own/);
  });
});
