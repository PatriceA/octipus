/**
 * The bundled Reader plugin (plugins/reader, docs/PLUGIN-PACKAGES.md#bundled-plugins):
 *
 * - its package is valid as the host checks it at install: the manifest, its
 *   contributions, its pages (plain paths, files present, served types, no
 *   inline script or style the page CSP would refuse) and its host scopes;
 * - its server, spawned as the host spawns it (node, stdio, no dependencies),
 *   answers MCP, lists exactly the declared tools, and does everything
 *   through the host API with its call's token, through its egress proxy:
 *   a fake proxy here records every request and answers as the host would.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { contributionInstallProblems } from '@/plugins/packages/contributions';
import { parseManifest } from '@/plugins/packages/manifest';
import { defaultMaxProtection, effectiveMaxProtection } from '@/plugins/packages/service';
import { isPlainRelativePath, uiDirOf } from '@/plugins/packages/manifest-ui-host';
import { checkPackageTree } from '@/plugins/packages/tree';
import { uiContentType } from '@/plugins/packages/ui';
import { PLUGIN_HOST_SCOPES } from '@/shared/plugin-package';
import { readerModule } from '@/modules/reader';

const DIR = join(import.meta.dirname, 'reader');
const manifest = parseManifest(JSON.parse(readFileSync(join(DIR, 'octipus-plugin.json'), 'utf8')));

function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const rel = prefix ? `${prefix}/${name}` : name;
    return statSync(join(dir, name)).isDirectory() ? filesUnder(join(dir, name), rel) : [rel];
  });
}

describe('the package', () => {
  test('its manifest is valid and asks for what the reader needs, and no more', async () => {
    expect(manifest).toMatchObject({ name: 'reader', server: { command: 'node', args: ['server.mjs'] } });
    expect(Object.fromEntries(Object.entries(manifest.tools ?? {}).map(([t, d]) => [t, d.effect]))).toEqual({
      read_url: 'read', reader_action: 'read', save_note: 'write', create_tasks: 'write',
    });
    expect(manifest.host).toEqual(['web:read', 'model:complete', 'notes:write', 'tasks:write']);
    for (const s of manifest.host ?? []) expect(PLUGIN_HOST_SCOPES).toContain(s);
    expect(manifest.runtime ?? 'package').toBe('package');
    // No network of its own: every page is fetched by the host (web:read).
    expect(manifest.network).toBeUndefined();
    // Yet a URL it names can carry data out: it may see level 1 only, as a package with network.
    expect(defaultMaxProtection(manifest)).toBe(1);
    expect(defaultMaxProtection({ host: ['notes:write'] })).toBe(4);
    expect(defaultMaxProtection({ network: ['api.example.com'] })).toBe(1);
    expect(defaultMaxProtection({ host: ['web:read'], maxProtection: 3 })).toBe(3);
    // Granted an egress scope, a package sees level 1 whatever its manifest says.
    expect(effectiveMaxProtection({ host: ['web:read', 'documents:read'], maxProtection: 4 }, ['web:read', 'documents:read'])).toBe(1);
    expect(effectiveMaxProtection({ host: ['model:complete', 'documents:read'], maxProtection: 4 }, ['model:complete', 'documents:read'])).toBe(1);
    expect(effectiveMaxProtection({ host: ['model:complete', 'documents:read'], maxProtection: 4 }, ['documents:read'])).toBe(4);
    expect(await contributionInstallProblems(manifest, DIR, [])).toEqual([]);
    await expect(checkPackageTree(DIR)).resolves.toBeUndefined();
    // Nothing but the package itself: no tests or build output inside it.
    expect(filesUnder(DIR).sort()).toEqual(['octipus-plugin.json', 'server.mjs', 'ui/app.js', 'ui/index.html', 'ui/style.css']);
  });

  test('the reader module it replaces is deprecated toward it, and no use case switches that on', () => {
    expect(readerModule.replacedBy?.plugin).toBe(manifest.name);
    expect(readerModule.replacedBy?.note).toContain('Bundled');
    expect(readerModule.profiles).toEqual([]);
  });

  test('its page is a plain static file set the page CSP can serve', () => {
    const ui = manifest.ui;
    expect(ui?.pages).toEqual([{ path: 'read', title: 'Reader', icon: 'newspaper', entry: 'index.html' }]);
    const uiDir = join(DIR, uiDirOf(ui));
    for (const page of ui?.pages ?? []) {
      expect(isPlainRelativePath(page.entry)).toBe(true);
      expect(existsSync(join(uiDir, page.entry))).toBe(true);
    }
    for (const file of filesUnder(uiDir)) expect(uiContentType(file), file).not.toBeNull();
    const html = readFileSync(join(uiDir, 'index.html'), 'utf8');
    // script-src and style-src name the package path only: no inline script, handler or style.
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/<style/i);
    // A sandboxed frame without allow-forms submits no form.
    expect(html).not.toMatch(/<form/i);
    // Resources are relative (served under /api/plugin-ui/reader/).
    for (const ref of html.matchAll(/\s(?:src|href)="([^"]+)"/g)) expect(isPlainRelativePath(ref[1]), ref[1]).toBe(true);
    // The script has no network of its own (connect-src 'none') and no modal dialog (the frame cannot open one).
    const js = readFileSync(join(uiDir, 'app.js'), 'utf8');
    expect(js).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|window\.prompt|\bprompt\(|\balert\(|\bconfirm\(/);
    // The bridge is a MessagePort: the page posts only its ready, to the parent's exact origin, and never listens on its window.
    expect(js).not.toMatch(/postMessage\([^)]*['"]\*['"]/);
    expect(js).not.toMatch(/addEventListener\(\s*['"]message['"]/);
    expect(js).toMatch(/new MessageChannel\(\)/);
    expect(js).toContain("window.parent.postMessage({ octipus: 'ready', nonce: nonce }, parentOrigin, [channel.port2])");
  });
});

// ── The server over stdio, against a fake host behind a fake proxy ─────────

interface Seen { method: string; path: string; auth: string | undefined; body: any }
type Answer = { status: number; body: unknown };

const seen: Seen[] = [];
let answer: (req: Seen) => Answer;
let proxy: Server;
let child: ChildProcessWithoutNullStreams;
let nextId = 1;
const pending = new Map<number, (msg: any) => void>();

const ARTICLE = {
  url: 'https://news.example.com/a', title: 'A plan', byline: 'Ada', siteName: 'Example News', publishedAt: '2026-11-01T00:00:00Z',
  contentHtml: '<p>Buy milk. Call Bob.</p>', textContent: 'Buy milk. Call Bob.', wordCount: 4, estReadMinutes: 1, truncated: false,
};

function hostAnswer(req: Seen): Answer {
  if (req.path === '/api/plugin-host/web/read') return { status: 200, body: { ...ARTICLE, url: req.body.url } };
  if (req.path === '/api/plugin-host/model/complete') return { status: 200, body: { output: '- Buy milk\n- Call Bob\n- buy milk', model: 'test' } };
  if (req.path === '/api/plugin-host/notes') return { status: 200, body: { id: 'n1', slug: 'a-plan' } };
  if (req.path === '/api/plugin-host/tasks') return { status: 200, body: { id: `t-${req.body.title}`, title: req.body.title, status: 'open' } };
  return { status: 404, body: { error: 'nope' } };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

function rpc(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

const meta = (scopes: string[]) => ({ 'octipus/host': { url: 'http://octipus-host.internal', token: 'ocph_test', expiresAt: new Date(Date.now() + 30_000).toISOString(), scopes } });
const ALL = ['web:read', 'model:complete', 'notes:write', 'tasks:write'];

async function call(name: string, args: Record<string, unknown>, scopes: string[] | null = ALL): Promise<{ isError: boolean; value: any }> {
  const msg = await rpc('tools/call', { name, arguments: args, ...(scopes ? { _meta: meta(scopes) } : {}) });
  const text = msg.result.content[0].text as string;
  let value: unknown = text;
  try { value = JSON.parse(text); } catch { /* plain text */ }
  return { isError: msg.result.isError === true, value };
}

beforeAll(async () => {
  proxy = createServer(async (req, res) => {
    // An HTTP proxy gets the absolute URL as the request target.
    const url = new URL(req.url ?? '');
    const raw = await readBody(req);
    const entry: Seen = { method: req.method ?? '', path: url.pathname, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined };
    if (url.host !== 'octipus-host.internal') {
      res.writeHead(403).end();
      return;
    }
    seen.push(entry);
    const out = answer(entry);
    res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const port = (proxy.address() as AddressInfo).port;
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: DIR,
    env: { PATH: process.env.PATH ?? '', HTTP_PROXY: `http://127.0.0.1:${port}`, OCTIPUS_HOST_URL: 'http://octipus-host.internal' },
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
});

afterAll(async () => {
  child?.kill();
  await new Promise((r) => proxy?.close(r));
});

beforeEach(() => {
  seen.length = 0;
  answer = hostAnswer;
});

describe('the server', () => {
  test('speaks MCP and offers exactly the declared tools', async () => {
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.result.serverInfo.name).toBe('reader');
    const list = await rpc('tools/list');
    expect(list.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(Object.keys(manifest.tools ?? {}).sort());
    expect((await rpc('nope')).error.code).toBe(-32601);
  });

  test('read_url has the host fetch the page, with the call\'s token, through the proxy', async () => {
    const out = await call('read_url', { url: 'https://news.example.com/a' });
    expect(out.isError).toBe(false);
    expect(out.value).toMatchObject({ title: 'A plan', siteName: 'Example News', text: 'Buy milk. Call Bob.', estReadMinutes: 1 });
    expect(out.value.contentHtml).toBeUndefined();
    expect(seen).toEqual([{ method: 'POST', path: '/api/plugin-host/web/read', auth: 'Bearer ocph_test', body: { url: 'https://news.example.com/a' } }]);
    expect((await call('read_url', { url: 'https://news.example.com/a', includeHtml: true })).value.contentHtml).toBe('<p>Buy milk. Call Bob.</p>');
  });

  test('without a token, the scope, or a web URL, nothing is asked of the host', async () => {
    expect(await call('read_url', { url: 'https://x.example.com' }, null)).toMatchObject({ isError: true, value: expect.stringContaining('no host API token') });
    expect(await call('read_url', { url: 'https://x.example.com' }, ['notes:write'])).toMatchObject({ isError: true, value: expect.stringContaining('web:read') });
    expect(await call('read_url', { url: 'file:///etc/passwd' })).toMatchObject({ isError: true, value: 'url must be an http(s) URL' });
    expect(await call('reader_action', { action: 'translate', text: 'Hallo' })).toMatchObject({ isError: true, value: expect.stringContaining('target language') });
    expect(await call('reader_action', { action: 'explode', text: 'x' })).toMatchObject({ isError: true });
    expect(await call('create_tasks', { items: ['  ', 7] })).toMatchObject({ isError: true, value: 'No action items to save' });
    expect(seen).toEqual([]);
  });

  test('a host refusal comes back as the tool\'s error', async () => {
    answer = () => ({ status: 422, body: { error: 'Blocked: private address', code: 'fetch_failed' } });
    expect(await call('read_url', { url: 'http://10.0.0.1/' })).toEqual({ isError: true, value: 'Blocked: private address' });
  });

  test('reader_action fetches a URL when given no text, frames the article as data, and parses action items', async () => {
    const out = await call('reader_action', { action: 'action_items', url: 'https://news.example.com/a' });
    expect(out).toMatchObject({ isError: false, value: { action: 'action_items', items: ['Buy milk', 'Call Bob', 'buy milk'] } });
    expect(seen.map((s) => s.path)).toEqual(['/api/plugin-host/web/read', '/api/plugin-host/model/complete']);
    const completion = seen[1].body;
    expect(completion.system).toContain('untrusted web content');
    expect(completion.prompt).toContain('<article_content>\nBuy milk. Call Bob.\n</article_content>');
    expect(completion.temperature).toBe(0);

    seen.length = 0;
    answer = (req) => (req.path.endsWith('/model/complete') ? { status: 200, body: { output: 'Bonjour' } } : hostAnswer(req));
    expect(await call('reader_action', { action: 'translate', text: 'Hello', argument: 'French' })).toEqual({ isError: false, value: { action: 'translate', output: 'Bonjour' } });
    expect(seen.map((s) => s.path)).toEqual(['/api/plugin-host/model/complete']);
    expect(seen[0].body.prompt).toContain('<target>French</target>');
  });

  test('a long article is cut before it reaches the model', async () => {
    await call('reader_action', { action: 'summarize', text: 'x'.repeat(20_000) });
    expect(seen[0].body.prompt).toContain('[article truncated for length]');
    expect(seen[0].body.prompt.length).toBeLessThan(13_000);
  });

  test('save_note links the article, tags it, and never overwrites a taken title', async () => {
    let taken = 1;
    answer = (req) => (req.path.endsWith('/notes') && taken-- > 0 ? { status: 409, body: { error: 'exists', code: 'exists' } } : hostAnswer(req));
    const out = await call('save_note', { title: 'A plan', body: 'Buy milk.', url: 'https://news.example.com/a' });
    expect(out).toEqual({ isError: false, value: { saved: true, id: 'n1', slug: 'a-plan', title: 'A plan (2)' } });
    expect(seen.map((s) => s.body)).toEqual([
      { title: 'A plan', body: 'Source: https://news.example.com/a\n\nBuy milk.', tags: ['reader'] },
      { title: 'A plan (2)', body: 'Source: https://news.example.com/a\n\nBuy milk.', tags: ['reader'] },
    ]);
  });

  test('create_tasks makes one task per distinct item, filed under Reading and linked to the article', async () => {
    const out = await call('create_tasks', { items: ['Buy milk', 'buy  milk', '  Call   Bob '], url: 'https://news.example.com/a', title: 'A plan' });
    expect(out).toEqual({ isError: false, value: { created: 2, tasks: [{ id: 't-Buy milk', title: 'Buy milk' }, { id: 't-Call Bob', title: 'Call Bob' }] } });
    expect(seen.map((s) => s.body)).toEqual([
      { title: 'Buy milk', category: 'Reading', notes: 'From: A plan — https://news.example.com/a', link: { url: 'https://news.example.com/a', label: 'A plan' } },
      { title: 'Call Bob', category: 'Reading', notes: 'From: A plan — https://news.example.com/a', link: { url: 'https://news.example.com/a', label: 'A plan' } },
    ]);
  });
});
