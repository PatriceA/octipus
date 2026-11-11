/**
 * Creator mode (docs/PLUGIN-PACKAGES.md#writing-a-plugin-with-an-agent),
 * without a database: the contract `plugin_api` returns is derived from the
 * code (a manifest field, event, effect or limit cannot be missing from it),
 * the validator reports every problem an install would refuse, every template
 * is a valid package whose server answers MCP over stdio, and the skill names
 * the tools that exist.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { createInterface } from 'node:readline';
import { describe, expect, test } from 'vitest';
import { DEFAULT_REQUEST_TIMEOUT_MS, MCP_PROTOCOL_VERSION } from '@/mcp/protocol';
import { MINIMAL_ENV_NAMES } from '@/security/child-env';
import { PLUGIN_EVENT_TYPES, PLUGIN_MANIFEST_FILE, PLUGIN_PACKAGE_API_VERSION, PLUGIN_RUNTIMES, PLUGIN_TOOL_EFFECTS } from '@/shared/plugin-package';
import { pluginDevTool } from '@/tools/plugin-dev';
import { MAX_PROMPT_CHARS } from '../contributions/prompt';
import { manifestSchema, parseManifest } from '../manifest';
import { contributionProblems } from '../manifest-contributions';
import { defaultMaxProtection } from '../service';
import { PLUGIN_HOST_SCOPES } from '@/shared/plugin-package';
import { MAX_PACKAGE_FILES } from '../tree';
import { manifestJsonSchema, PLUGIN_DEV_TOOLS, pluginApiContract, pluginDevToolName } from './contract';
import { PLUGIN_AUTHORING_SKILL } from './skill';
import { listTemplates, readTemplate, templatesRoot } from './templates';
import { IN_PROCESS_REFUSAL, validatePluginDirectory } from './validate';

const contract = () => pluginApiContract({ canInstall: false, network: () => ({ state: 'not_enforced', detail: 'test' }), adminPage: 'http://x/admin/plugins', shellSandboxed: false });

/** A copy of a template in a temp dir, its manifest changed by `change`. */
function copyOf(template: string, change?: (m: Record<string, unknown>) => Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'octipus-authoring-'));
  cpSync(join(templatesRoot(), template), dir, { recursive: true });
  if (change) {
    const file = join(dir, PLUGIN_MANIFEST_FILE);
    writeFileSync(file, JSON.stringify(change(JSON.parse(readFileSync(file, 'utf8')))));
  }
  return dir;
}

/** Start a package's server and talk MCP to it over stdio. */
function mcp(dir: string, command: string, args: string[], env: Record<string, string>) {
  const child = spawn(command, args, { cwd: dir, env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map<number, (msg: Record<string, unknown>) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line) as { id: number };
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  let id = 0;
  return {
    request(method: string, params?: unknown): Promise<Record<string, unknown>> {
      const n = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method}: no answer`)), 5_000);
        waiting.set(n, (msg) => { clearTimeout(timer); resolve(msg); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
      });
    },
    notify(method: string) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
    stop() {
      child.kill();
    },
  };
}

describe('plugin_api contract', () => {
  test('the manifest schema is derived from the zod schema: every field is in it', async () => {
    const schema = manifestJsonSchema() as { properties: Record<string, unknown>; additionalProperties?: boolean };
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(manifestSchema.shape).sort());
    expect(schema.additionalProperties).toBe(false);
    expect((await contract()).manifestSchema).toEqual(schema);
  });

  test('events, effects, runtimes, limits, environment and MCP come from the code', async () => {
    const c = await contract();
    expect(c.apiVersion).toBe(PLUGIN_PACKAGE_API_VERSION);
    expect(c.manifestFile).toBe(PLUGIN_MANIFEST_FILE);
    expect(Object.keys(c.toolEffects)).toEqual([...PLUGIN_TOOL_EFFECTS]);
    expect(Object.keys(c.contributions.events as object).sort()).toEqual([...PLUGIN_EVENT_TYPES].sort());
    expect(Object.keys(c.runtimes)).toEqual([...PLUGIN_RUNTIMES]);
    expect(c.limits).toMatchObject({ maxPromptChars: MAX_PROMPT_CHARS, maxPackageFiles: MAX_PACKAGE_FILES, defaultRequestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS });
    expect(c.mcp.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(c.environment.fromHost).toEqual([...MINIMAL_ENV_NAMES]);
    expect(c.environment.proxy).toContain('HTTPS_PROXY');
    expect(c.environment.settings).toContain('OCTIPUS_SETTING_<KEY>');
    expect((c.contributions.cron as { fields: unknown[] }).fields).toHaveLength(5);
    expect(c.sandbox.thisHostWithHosts).toEqual({ state: 'not_enforced', detail: 'test' });
    expect(c.install.youCanInstall).toBe(false);
    expect(c.sandbox.shellCommandsSandboxed).toBe(false);
    expect((await pluginApiContract({ canInstall: true, network: () => ({ state: 'x', detail: 'x' }), adminPage: 'x', shellSandboxed: true })).sandbox.shellCommandsSandboxed).toBe(true);
    // The default protection level, from the function the server uses.
    expect(c.defaultMaxProtection.examples).toEqual({ nothing: 4, networkHosts: 1, hostWebRead: 1, hostAgentRun: 1, uiPages: 1, uiPagesDeclared4: 1 });
    expect(c.defaultMaxProtection.examples.networkHosts).toBe(defaultMaxProtection({ network: ['a.example.com'] }));
    expect(c.templates.map((t) => t.name)).toEqual(['tool-only', 'with-command', 'with-schedule', 'with-store']);
    // Every host scope is described, with its endpoint.
    expect(Object.keys(c.hostApi.scopes).sort()).toEqual([...PLUGIN_HOST_SCOPES].sort());
    expect(c.hostApi.scopes['documents:write']).toContain('POST /api/plugin-host/documents');
    expect(c.hostApi.scopes['agent:run']).toContain('POST /api/plugin-host/agent/runs');
    expect(c.hostApi.effects).toContain('agent:run');
    // The store: its endpoints, and the data directory said plainly to be shared by every user.
    expect(c.hostApi.scopes['store:write']).toContain('PUT /api/plugin-host/store/<key>');
    expect(c.hostApi.effects).toContain('store:write');
    expect(c.environment.dataDir).toMatch(/SHARED BY ALL USERS/);
    expect(c.manifestRules.join('\n')).toMatch(/store: \{ "quotaBytes"/);
  });

  test('the tools it names are the tools plugin_dev registers', async () => {
    await pluginDevTool.initialize();
    const handlers = pluginDevTool.getToolHandlers().map((h) => h.name).sort();
    expect(handlers).toEqual(Object.keys(PLUGIN_DEV_TOOLS).map((k) => pluginDevToolName(k as keyof typeof PLUGIN_DEV_TOOLS)).sort());
    expect(Object.keys((await contract()).tools).sort()).toEqual(handlers);
    // Nothing enables or approves: those stay a person's action.
    expect(handlers.some((h) => /enable|approve/.test(h))).toBe(false);
    const install = pluginDevTool.getManifest().permissions.find((p) => p.action === 'write');
    expect(install).toMatchObject({ defaultLevel: 'ASK', dangerous: true });
  });
});

describe('templates', () => {
  test('each template is a valid package: manifest, contributions, tree, server files', async () => {
    const templates = await listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(3);
    for (const t of templates) {
      const template = await readTemplate(t.name);
      if (!template) throw new Error(`template ${t.name} is missing`);
      const manifest = parseManifest(JSON.parse(template.files[PLUGIN_MANIFEST_FILE]));
      expect(contributionProblems(manifest), t.name).toEqual([]);
      expect(manifest.runtime ?? 'package').toBe('package');
      const result = await validatePluginDirectory(join(templatesRoot(), t.name));
      expect(result.problems, t.name).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect((await readTemplate('with-schedule'))?.contributes).toEqual(['schedules']);
    expect((await readTemplate('with-command'))?.contributes).toEqual(['commands']);
    expect(await readTemplate('../packages')).toBeNull();
    expect(await readTemplate('nope')).toBeNull();
  });

  test('each template server answers initialize, lists exactly its declared tools, and runs them', async () => {
    for (const t of await listTemplates()) {
      const dir = join(templatesRoot(), t.name);
      const manifest = parseManifest(JSON.parse(readFileSync(join(dir, PLUGIN_MANIFEST_FILE), 'utf8')));
      const data = mkdtempSync(join(tmpdir(), 'octipus-template-data-'));
      // A template with host scopes reaches a stand-in for the host API, through HTTP_PROXY as under Octipus.
      const fake = manifest.host?.length ? await fakeStoreHost() : null;
      const env: Record<string, string> = { OCTIPUS_PLUGIN_DATA_DIR: data, ...(fake ? { HTTP_PROXY: fake.url } : {}) };
      const server = mcp(dir, manifest.server?.command ?? '', manifest.server?.args ?? [], env);
      try {
        const init = await server.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '0' } });
        expect(init.result).toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} } });
        server.notify('notifications/initialized');
        const list = await server.request('tools/list');
        const tools = (list.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
        expect(tools.map((x) => x.name).sort(), t.name).toEqual(Object.keys(manifest.tools ?? {}).sort());
        for (const tool of tools) {
          const effect = manifest.tools?.[tool.name]?.effect ?? 'read';
          const _meta = fake ? { 'octipus/host': { url: 'http://octipus-host.internal', token: 'ocph_test', expiresAt: '', scopes: effect === 'read' ? ['store:read'] : ['store:read', 'store:write'] } } : undefined;
          const call = await server.request('tools/call', { name: tool.name, arguments: { name: 'Ada', text: 'one two', source: 'test' }, ...(_meta ? { _meta } : {}) });
          const result = call.result as { content: Array<{ text: string }>; isError?: boolean };
          expect(result.isError, `${t.name}.${tool.name}: ${result.content[0].text}`).toBeUndefined();
        }
        if (t.name === 'with-store') {
          // What remember wrote, recall read back, as the same user, through the store only.
          expect([...(fake?.entries.keys() ?? [])]).toEqual(['memo/Ada']);
          const recalled = await server.request('tools/call', { name: 'recall', arguments: { name: 'Ada' }, _meta: { 'octipus/host': { url: 'http://octipus-host.internal', token: 'ocph_test', expiresAt: '', scopes: ['store:read'] } } });
          expect((recalled.result as { content: Array<{ text: string }> }).content[0].text).toBe('one two');
          const noToken = await server.request('tools/call', { name: 'remember', arguments: { text: 'x' } });
          expect((noToken.result as { isError?: boolean }).isError).toBe(true);
          expect(readdirSync(data)).toEqual([]);
        }
        const unknown = await server.request('tools/call', { name: 'nope', arguments: {} });
        expect((unknown.result as { isError?: boolean }).isError).toBe(true);
        expect((await server.request('no/such/method')).error).toMatchObject({ code: -32601 });
      } finally {
        server.stop();
        fake?.server.close();
        rmSync(data, { recursive: true, force: true });
      }
    }
  });
});

/** A stand-in for the host API's store behind an HTTP proxy: absolute-form requests to octipus-host.internal, entries in memory. */
async function fakeStoreHost(): Promise<{ url: string; server: Server; entries: Map<string, { value: unknown; version: number }> }> {
  const entries = new Map<string, { value: unknown; version: number }>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '', 'http://x');
      const answer = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (url.host !== 'octipus-host.internal' || req.headers.authorization !== 'Bearer ocph_test') return answer(401, { error: 'no' });
      const key = url.pathname.startsWith('/api/plugin-host/store/') ? url.pathname.slice('/api/plugin-host/store/'.length) : null;
      if (req.method === 'GET' && url.pathname === '/api/plugin-host/store') {
        const prefix = url.searchParams.get('prefix') ?? '';
        return answer(200, { keys: [...entries.keys()].filter((k) => k.startsWith(prefix)).sort().map((k) => ({ key: k, size: 1, version: entries.get(k)?.version, updatedAt: '' })), withheld: 0, truncated: false });
      }
      if (key && req.method === 'GET') return entries.has(key) ? answer(200, entries.get(key)) : answer(404, { error: 'No such key', code: 'not_found' });
      if (key && req.method === 'PUT') {
        const version = (entries.get(key)?.version ?? 0) + 1;
        entries.set(key, { value: JSON.parse(Buffer.concat(chunks).toString('utf8')).value, version });
        return answer(200, { version });
      }
      return answer(404, { error: 'unexpected' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server, entries };
}

describe('plugin_validate', () => {
  test('a missing directory, a missing or broken manifest', async () => {
    expect((await validatePluginDirectory('/nonexistent/octipus-plugin')).problems[0]).toMatch(/not a directory/);
    const empty = mkdtempSync(join(tmpdir(), 'octipus-authoring-'));
    expect((await validatePluginDirectory(empty)).problems).toEqual([`No ${PLUGIN_MANIFEST_FILE} at the root of ${empty}`]);
    writeFileSync(join(empty, PLUGIN_MANIFEST_FILE), '{ nope');
    expect((await validatePluginDirectory(empty)).problems[0]).toMatch(/is not valid JSON/);
  });

  test('every problem at once: manifest, contributions, server files, tree', async () => {
    const dir = copyOf('with-schedule', (m) => ({
      ...m,
      server: { command: 'node', args: ['dist/server.mjs', '../outside.mjs'] },
      schedules: [{ id: 'bad', cron: '61 * * * *', tool: 'check' }, { id: 'ghost', cron: '* * * * *', tool: 'missing' }],
      tools: { ...(m.tools as object), Bad: { effect: 'delete' } },
    }));
    symlinkSync('/etc/hostname', join(dir, 'link'));
    const result = await validatePluginDirectory(dir);
    expect(result.ok).toBe(false);
    expect(result.contentHash).toBeNull();
    const all = result.problems.join('\n');
    expect(all).toMatch(/symbolic link/);
    expect(all).toMatch(/effect/);
    // The manifest refused, its server and contribution checks wait for a manifest that parses.
    const fixed = copyOf('with-schedule', (m) => ({
      ...m,
      server: { command: 'node', args: ['dist/server.mjs', '../outside.mjs'] },
      schedules: [{ id: 'bad', cron: '61 * * * *', tool: 'check' }],
    }));
    const second = await validatePluginDirectory(fixed);
    expect(second.problems).toEqual(expect.arrayContaining([
      expect.stringContaining('schedules.bad: cron'),
    ]));
    const files = copyOf('tool-only', (m) => ({ ...m, server: { command: 'node', args: ['dist/server.mjs', '../outside.mjs'] } }));
    expect((await validatePluginDirectory(files)).problems).toEqual([
      'server.args: dist/server.mjs is not a file in the package',
      'server.args: ../outside.mjs leads outside the package (the server runs from the package directory; reference its own files)',
    ]);
  });

  test('a command name the host or an installed package uses; an installed name is a warning', async () => {
    const clash = copyOf('with-command', (m) => ({ ...m, commands: [{ name: 'help', tool: 'count_words', description: 'x' }] }));
    expect((await validatePluginDirectory(clash)).problems).toEqual([expect.stringContaining('/help is a command of Octipus')]);
    const dir = copyOf('with-command');
    const other = { name: 'other', version: '1.0.0', manifest: { ...parseManifest(JSON.parse(readFileSync(join(dir, PLUGIN_MANIFEST_FILE), 'utf8'))), name: 'other' } };
    expect((await validatePluginDirectory(dir, [other])).problems).toEqual(['commands: /wordcount is already a command of the plugin package other']);
    const self = { ...other, name: 'my-command' };
    const again = await validatePluginDirectory(dir, [self]);
    expect(again.ok).toBe(true);
    expect(again.warnings).toEqual([expect.stringContaining('my-command is installed (version 1.0.0)')]);
  });

  test('in-process is refused with a clear message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'octipus-authoring-'));
    writeFileSync(join(dir, PLUGIN_MANIFEST_FILE), JSON.stringify({
      name: 'sneaky', version: '1.0.0', apiVersion: '1.0.0', title: 'x', description: 'x', runtime: 'in-process', entry: 'index.mjs',
    }));
    writeFileSync(join(dir, 'index.mjs'), 'export default () => {};');
    const result = await validatePluginDirectory(dir);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([IN_PROCESS_REFUSAL]);
  });

  test('a command not on PATH is a warning; a relative command must be in the package', async () => {
    const dir = copyOf('tool-only', (m) => ({ ...m, server: { command: 'definitely-not-a-binary-xyz', args: ['server.mjs'] } }));
    const result = await validatePluginDirectory(dir);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([expect.stringContaining('is not on this host\'s PATH')]);
    mkdirSync(join(dir, 'bin'));
    const rel = copyOf('tool-only', (m) => ({ ...m, server: { command: './bin/run', args: [] } }));
    expect((await validatePluginDirectory(rel)).problems).toEqual(['server.command: ./bin/run is not a file in the package']);
  });
});

describe('the skill', () => {
  test('names every plugin_dev tool and the real loop', () => {
    for (const key of Object.keys(PLUGIN_DEV_TOOLS) as Array<keyof typeof PLUGIN_DEV_TOOLS>) {
      expect(PLUGIN_AUTHORING_SKILL.content).toContain(pluginDevToolName(key));
    }
    expect(PLUGIN_AUTHORING_SKILL.content).toContain('disabled');
    expect(PLUGIN_AUTHORING_SKILL.content).toContain('youCanInstall');
    // Runs agent-written code on the host only inside the shell sandbox.
    expect(PLUGIN_AUTHORING_SKILL.content).toContain('sandbox.shellCommandsSandboxed');
    expect(PLUGIN_AUTHORING_SKILL.content).toContain(MCP_PROTOCOL_VERSION);
    expect(PLUGIN_AUTHORING_SKILL.content).not.toMatch(/plugin_enable|plugin_approve/);
  });

  test('points to the example plugins, and keeps the source out of the repository', () => {
    expect(PLUGIN_AUTHORING_SKILL.content).toMatch(/\bplugins\/reader\b/);
    expect(PLUGIN_AUTHORING_SKILL.content).toMatch(/\bplugins\/research\b/);
    expect(PLUGIN_AUTHORING_SKILL.content).toContain('my-plugins/<name>/');
    expect(PLUGIN_AUTHORING_SKILL.content).not.toContain('`plugins/<name>/`');
    expect(PLUGIN_AUTHORING_SKILL.content).toMatch(/never in the Octipus repository/);
  });
});
