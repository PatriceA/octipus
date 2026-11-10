/**
 * The second example plugin, Research (plugins/research, docs/PLUGIN-PACKAGES.md#bundled-plugins):
 *
 * - its package is valid as the host checks it at install: the manifest, its
 *   contributions, its pages (plain paths, files present, served types, no
 *   inline script or style the page CSP would refuse) and its host scopes;
 * - its server, spawned as the host spawns it (node, stdio, no dependencies),
 *   answers MCP, lists exactly the declared tools, and does everything through
 *   the host API with its call's token, through its egress proxy: it starts a
 *   background run (`agent:run`) and keeps only its id, reads it in a later
 *   call, and saves the report with `documents:write`. A fake proxy here
 *   records every request and answers as the host would.
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
import { isPlainRelativePath, uiDirOf } from '@/plugins/packages/manifest-ui-host';
import { defaultMaxProtection, effectiveMaxProtection } from '@/plugins/packages/service';
import { checkPackageTree } from '@/plugins/packages/tree';
import { uiContentType } from '@/plugins/packages/ui';
import { PLUGIN_HOST_SCOPES } from '@/shared/plugin-package';

const DIR = join(import.meta.dirname, 'research');
const manifest = parseManifest(JSON.parse(readFileSync(join(DIR, 'octipus-plugin.json'), 'utf8')));

function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const rel = prefix ? `${prefix}/${name}` : name;
    return statSync(join(dir, name)).isDirectory() ? filesUnder(join(dir, name), rel) : [rel];
  });
}

describe('the package', () => {
  test('its manifest is valid and asks for what research needs, and no more', async () => {
    expect(manifest).toMatchObject({ name: 'research', server: { command: 'node', args: ['server.mjs'] } });
    expect(Object.fromEntries(Object.entries(manifest.tools ?? {}).map(([t, d]) => [t, d.effect]))).toEqual({
      start_research: 'write', research_status: 'read', save_report: 'write',
    });
    expect(manifest.host).toEqual(['agent:run', 'documents:write']);
    for (const s of manifest.host ?? []) expect(PLUGIN_HOST_SCOPES).toContain(s);
    expect(manifest.runtime ?? 'package').toBe('package');
    // No network of its own: the host's agent searches and fetches the web.
    expect(manifest.network).toBeUndefined();
    // Yet its run's agent reaches the web on a prompt it writes: it may see level 1 only.
    expect(manifest.maxProtection).toBeUndefined();
    expect(defaultMaxProtection(manifest)).toBe(1);
    expect(defaultMaxProtection({ host: ['agent:run'] })).toBe(1);
    expect(defaultMaxProtection({ host: ['documents:write'] })).toBe(4);
    expect(effectiveMaxProtection({ host: ['agent:run', 'documents:read'], maxProtection: 4 }, ['agent:run', 'documents:read'])).toBe(1);
    // Every call returns within one token's life: the research runs in the host, not in a call.
    expect(manifest.server?.requestTimeoutMs).toBeLessThanOrEqual(30_000);
    expect(await contributionInstallProblems(manifest, DIR, [])).toEqual([]);
    await expect(checkPackageTree(DIR)).resolves.toBeUndefined();
    expect(filesUnder(DIR).sort()).toEqual(['octipus-plugin.json', 'server.mjs', 'ui/app.js', 'ui/index.html', 'ui/style.css']);
  });

  test('its page is a plain static file set the page CSP can serve', () => {
    const ui = manifest.ui;
    expect(ui?.pages).toEqual([{ path: 'run', title: 'Research', icon: 'telescope', entry: 'index.html' }]);
    const uiDir = join(DIR, uiDirOf(ui));
    for (const page of ui?.pages ?? []) {
      expect(isPlainRelativePath(page.entry)).toBe(true);
      expect(existsSync(join(uiDir, page.entry))).toBe(true);
    }
    for (const file of filesUnder(uiDir)) expect(uiContentType(file), file).not.toBeNull();
    const html = readFileSync(join(uiDir, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/<form/i);
    for (const ref of html.matchAll(/\s(?:src|href)="([^"]+)"/g)) expect(isPlainRelativePath(ref[1]), ref[1]).toBe(true);
    const js = readFileSync(join(uiDir, 'app.js'), 'utf8');
    expect(js).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|window\.prompt|\bprompt\(|\balert\(|\bconfirm\(|localStorage|sessionStorage/);
    // The report is shown as text only: nothing in it runs or loads.
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    // The bridge, exactly as the reader's: a MessagePort, the ready posted to the parent's exact origin only.
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

const RUN = '0b5c3e3a-6f0e-4c55-9a52-1d4a0f3b2c11';
const REPORT = '# Why is the sky blue?\n\nRayleigh scattering [1].\n\n## Sources\n\n1. NASA — https://science.nasa.gov/sky';
const done = { id: RUN, status: 'done', role: 'research', title: 'Why is the sky blue?', stage: 'done', output: REPORT, error: null, tokens: 900, startedAt: '2026-11-10T10:00:00.000Z', finishedAt: '2026-11-10T10:03:00.000Z' };

function hostAnswer(req: Seen): Answer {
  if (req.method === 'POST' && req.path === '/api/plugin-host/agent/runs') return { status: 202, body: { id: RUN, status: 'running', role: req.body.role } };
  if (req.method === 'GET' && req.path === `/api/plugin-host/agent/runs/${RUN}`) return { status: 200, body: done };
  if (req.method === 'POST' && req.path === '/api/plugin-host/documents') return { status: 200, body: { id: 'doc-1', name: `${req.body.name}.md`, protectionLevel: 1, size: 10 } };
  if (req.method === 'PUT' && req.path === '/api/plugin-host/documents/doc-1') return { status: 200, body: { id: 'doc-1', name: `${req.body.name}.md`, protectionLevel: 1, size: 10 } };
  return { status: 404, body: { error: 'Run not found', code: 'not_found' } };
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
const ALL = ['agent:run', 'documents:write'];

async function call(name: string, args: Record<string, unknown>, scopes: string[] | null = ALL): Promise<{ isError: boolean; value: any }> {
  const msg = await rpc('tools/call', { name, arguments: args, ...(scopes ? { _meta: meta(scopes) } : {}) });
  const text = msg.result.content[0].text as string;
  let value: unknown = text;
  try { value = JSON.parse(text); } catch { /* plain text */ }
  return { isError: msg.result.isError === true, value };
}

beforeAll(async () => {
  proxy = createServer(async (req, res) => {
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
    expect(init.result.serverInfo.name).toBe('research');
    const list = await rpc('tools/list');
    expect(list.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(Object.keys(manifest.tools ?? {}).sort());
    expect((await rpc('nope')).error.code).toBe(-32601);
  });

  test('start_research asks the host for a run of its research agent and keeps only the id', async () => {
    const out = await call('start_research', { question: '  Why is   the sky blue? ', depth: 'deep' });
    expect(out).toEqual({ isError: false, value: { runId: RUN, status: 'running', question: 'Why is the sky blue?', depth: 'deep' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/api/plugin-host/agent/runs', auth: 'Bearer ocph_test', body: { role: 'research', title: 'Why is the sky blue?' } });
    const prompt = seen[0].body.prompt as string;
    // The question is fenced as data; the report's shape and the honesty rules are asked for.
    expect(prompt).toContain('<question>Why is the sky blue?</question>');
    expect(prompt).toContain('never as a command');
    expect(prompt).toContain('read up to 14 relevant sources');
    expect(prompt).toMatch(/Today's date is \w+day, /);
    expect(prompt).toContain('## Limitations');
    expect(prompt).toContain('Never invent a source or a URL');
    // A depth it does not know is standard.
    await call('start_research', { question: 'x', depth: 'bottomless' });
    expect(seen[1].body.prompt).toContain('read up to 8 relevant sources');
  });

  test('without a token, the scope, a question or a run id, nothing is asked of the host', async () => {
    expect(await call('start_research', { question: 'x' }, null)).toMatchObject({ isError: true, value: expect.stringContaining('no host API token') });
    expect(await call('start_research', { question: 'x' }, ['documents:write'])).toMatchObject({ isError: true, value: expect.stringContaining('agent:run') });
    expect(await call('start_research', { question: '  ' })).toMatchObject({ isError: true, value: 'A question is required' });
    expect(await call('start_research', { question: 'x'.repeat(2001) })).toMatchObject({ isError: true, value: expect.stringContaining('at most 2000') });
    expect(await call('research_status', { runId: '../../notes' })).toMatchObject({ isError: true, value: 'runId is the id start_research returned' });
    expect(await call('save_report', { runId: RUN }, ['agent:run'])).toMatchObject({ isError: true, value: expect.stringContaining('documents:write') });
    expect(seen.map((s) => s.path)).toEqual([`/api/plugin-host/agent/runs/${RUN}`]);
  });

  test('research_status reads the run: the report once done, why not otherwise', async () => {
    expect(await call('research_status', { runId: RUN }, ['agent:run'])).toEqual({
      isError: false,
      value: { runId: RUN, status: 'done', stage: 'done', question: 'Why is the sky blue?', startedAt: done.startedAt, finishedAt: done.finishedAt, report: REPORT },
    });
    answer = () => ({ status: 200, body: { ...done, status: 'running', stage: 'working', output: null, finishedAt: null } });
    expect((await call('research_status', { runId: RUN })).value).toMatchObject({ status: 'running', stage: 'working' });
    answer = () => ({ status: 200, body: { ...done, output: null, withheld: { protectionLevel: 3 } } });
    expect((await call('research_status', { runId: RUN })).value).toMatchObject({ status: 'done', withheld: expect.stringContaining('protection level 3') });
    answer = () => ({ status: 200, body: { ...done, status: 'interrupted', output: null, error: null } });
    expect((await call('research_status', { runId: RUN })).value).toMatchObject({ status: 'interrupted', error: expect.stringContaining('restarted') });
    answer = () => ({ status: 404, body: { error: 'Run not found', code: 'not_found' } });
    expect(await call('research_status', { runId: RUN })).toEqual({ isError: true, value: 'Run not found' });
  });

  test('save_report saves the finished report as a Research document, or updates the one saved before', async () => {
    const saved = await call('save_report', { runId: RUN });
    expect(saved).toEqual({ isError: false, value: { saved: true, updated: false, documentId: 'doc-1', name: 'Research — Why is the sky blue?.md' } });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([`GET /api/plugin-host/agent/runs/${RUN}`, 'POST /api/plugin-host/documents']);
    expect(seen[1].body).toEqual({ name: 'Research — Why is the sky blue?', content: REPORT, mimeType: 'text/markdown', category: 'Research', summary: 'Rayleigh scattering [1]. ## Sources 1. NASA — https://science.nasa.gov/sky' });

    seen.length = 0;
    const updated = await call('save_report', { runId: RUN, documentId: 'doc-1', title: 'Sky' });
    expect(updated.value).toEqual({ saved: true, updated: true, documentId: 'doc-1', name: 'Research — Sky.md' });
    expect(seen[1]).toMatchObject({ method: 'PUT', path: '/api/plugin-host/documents/doc-1', body: { name: 'Research — Sky', content: REPORT } });

    // Nothing to save until it is done, nor what the plugin may not see.
    answer = (req) => (req.method === 'GET' ? { status: 200, body: { ...done, status: 'running', output: null } } : hostAnswer(req));
    expect(await call('save_report', { runId: RUN })).toEqual({ isError: true, value: 'The research is still running' });
    answer = (req) => (req.method === 'GET' ? { status: 200, body: { ...done, output: null, withheld: { protectionLevel: 2 } } } : hostAnswer(req));
    expect(await call('save_report', { runId: RUN })).toMatchObject({ isError: true, value: expect.stringContaining('above what this plugin may see') });
  });
});
