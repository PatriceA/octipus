/**
 * Skill registries through the routes (docs/SKILL-EXCHANGE.md#registries),
 * against a local fake registry served over HTTP on 127.0.0.1: browse and
 * search, install only through preview → install, the index digest and the
 * bundle signature both required, hostile indexes and bundle URLs refused,
 * nothing fetched without a configured registry, an update shown and never
 * applied — on a real embedded database.
 *
 * The SSRF guard itself is real: only the fake registry's host name
 * (`skills.registry.test`) is routed to the local server; any other URL goes
 * through the actual `fetchGuarded`, which refuses private addresses.
 */
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

process.env.HOME = mkdtempSync(join(tmpdir(), 'octipus-skills-registry-home-'));
process.env.MASTER_KEY ??= `test-${randomUUID()}`;
process.env.JWT_SECRET ??= `test-${randomUUID()}`;
process.env.SESSION_SECRET ??= `test-${randomUUID()}`;
process.env.LOG_LEVEL = 'error';
process.env.STORAGE_MODE = 'embedded';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-skills-registry-'));

const REGISTRY_HOST = 'skills.registry.test';
const fake = vi.hoisted(() => ({ port: 0, files: new Map<string, { status?: number; body?: Buffer | string; location?: string }>(), requests: [] as string[] }));
vi.mock('@/utils/sanitize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/sanitize')>();
  return {
    ...actual,
    fetchGuarded: async (url: string, init: RequestInit = {}, maxRedirects?: number) => {
      const parsed = new URL(url);
      if (parsed.hostname !== 'skills.registry.test') return actual.fetchGuarded(url, init, maxRedirects);
      // The fake registry: the same request, sent to the local server.
      return fetch(`http://127.0.0.1:${fake.port}${parsed.pathname}${parsed.search}`, { ...init, redirect: 'manual' });
    },
  };
});

const { Elysia } = await import('@/api/http');
const { closeDb, getDb, initializeDb } = await import('@/db/postgres');
const { runMigrations } = await import('@/db/migrate');
const { skills } = await import('@/db/schema/skills');
const { skillRegistryInstalls } = await import('@/db/schema/skill-registry-installs');
const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
const { principalFromUser } = await import('@/security/principal');
const { getConfig } = await import('@/config');
const { auditRepository } = await import('@/db/repositories/audit-repository');
const { generateSigningKey } = await import('@/plugins/packages/signature');
const { buildBundle } = await import('@/skills/exchange');
const { clearSkillRegistryCache, REGISTRY_FETCH_LIMIT } = await import('@/skills/registries');
const { MAX_SKILL_INDEX_BYTES } = await import('@/skills/registry-index');
const { skillRoutes } = await import('./skills');

type TestUser = { id: string; username: string; isAdmin: boolean };
const alice: TestUser = { id: randomUUID(), username: 'alice', isAdmin: false };
let current: TestUser | null = alice;
let scopes: string[] | undefined;
let app: { handle(req: Request): Promise<Response> };
let server: Server;
const acme = generateSigningKey();
const other = generateSigningKey();
const stranger = generateSigningKey();

async function call(method: string, path: string, body?: unknown) {
  const response = await app.handle(new Request(`http://localhost/skills/${path}`, {
    method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  }));
  return { status: response.status, body: await response.json() as any };
}
const browse = (query = '') => call('GET', `exchange/registry${query}`);
const source = (name: string, version: string, registry = 'acme') => ({ registry: { registry, name, version } });
const preview = (src: Record<string, unknown>) => call('POST', 'exchange/preview', src);
const install = (src: Record<string, unknown>, contentHash: string, decisions?: unknown[]) =>
  call('POST', 'exchange/install', { ...src, contentHash, ...(decisions ? { decisions } : {}) });

const skill = (name: string, content = `# ${name}\n\nDo the thing.`) => ({
  name, category: 'writing', description: `${name} description`, content, principles: [], bestPractices: [], antiPatterns: [], frameworks: [],
});
const url = (path: string) => `https://${REGISTRY_HOST}${path}`;
const sha = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Serve a bundle at `path` and return the index entry that lists it (overridable, to lie). */
function publish(path: string, listing: { name: string; version: string; description?: string; tags?: string[] }, skillList: ReturnType<typeof skill>[], key?: string, over: Record<string, unknown> = {}) {
  const bundle = buildBundle(skillList, key);
  const text = JSON.stringify(bundle);
  fake.files.set(path, { body: text });
  return {
    name: listing.name, version: listing.version, description: listing.description ?? `${listing.name} skills`, tags: listing.tags ?? [], author: 'Acme',
    publisherKeyId: bundle.signature?.keyId ?? null, skills: skillList.map((s) => s.name),
    bundleUrl: url(path), bundleSha256: sha(text), contentHash: bundle.contentHash, ...over,
  };
}
function serveIndex(entries: unknown[], path = '/index.json') {
  fake.files.set(path, { body: JSON.stringify({ format: 'octipus-skill-index', version: 1, generatedAt: '2026-11-23T10:00:00Z', entries }) });
}
function configure(registries: Array<{ name: string; url: string; publishers: string[] }>) {
  getConfig().skills.registries = registries;
  clearSkillRegistryCache();
}
const ACME = { name: 'acme', url: url('/index.json'), publishers: ['Acme'] };

beforeAll(async () => {
  server = createServer((req, res) => {
    fake.requests.push(req.url ?? '');
    const file = fake.files.get(new URL(req.url ?? '/', 'http://x').pathname);
    if (!file) { res.writeHead(404).end('not found'); return; }
    if (file.location) { res.writeHead(file.status ?? 302, { location: file.location }).end(); return; }
    res.writeHead(file.status ?? 200, { 'content-type': 'application/json' }).end(file.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = (server.address() as AddressInfo).port;
  await initializeDb();
  await runMigrations();
  await seedUsers([alice]);
  app = new Elysia()
    .derive(() => ({
      user: current,
      principal: current ? { ...principalFromUser(current), ...(scopes ? { scopes } : {}) } : { kind: 'anonymous' as const, userId: 'anonymous', username: 'anonymous', isAdmin: false },
      session: current ? { userAgent: 'Mozilla/5.0' } : null,
    }))
    .use(skillRoutes);
}, 60000);

beforeEach(async () => {
  current = alice;
  scopes = undefined;
  fake.files.clear();
  fake.requests = [];
  Object.assign(getConfig().plugins, {
    requireSignature: false, revokedKeys: [],
    trustedPublishers: [{ name: 'Acme', publicKey: acme.publicKeyPem }, { name: 'Other', publicKey: other.publicKeyPem }],
  });
  configure([]);
  await getDb().delete(skills);
  await getDb().delete(skillRegistryInstalls);
});

afterAll(async () => {
  configure([]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
});

test('no registry configured: nothing is fetched, nothing listed, a registry import is refused', async () => {
  serveIndex([publish('/notes.json', { name: 'notes', version: '1.0.0' }, [skill('Notes')], acme.privateKeyPem)]);
  const listing = await browse();
  expect(listing.status).toBe(200);
  expect(listing.body).toEqual({ registries: [], listings: [], errors: [], problems: [], truncated: false });
  const refused = await preview(source('notes', '1.0.0'));
  expect(refused.status).toBe(400);
  expect(refused.body.error).toMatch(/not a skill registry configured here/);
  expect(fake.requests).toEqual([]);
  current = null;
  expect((await browse()).status).toBe(401);
});

test('browse: newest version per name, the listed signature status for this registry, the index cached', async () => {
  serveIndex([
    publish('/notes-1.0.0.json', { name: 'notes', version: '1.0.0' }, [skill('Notes')], acme.privateKeyPem),
    publish('/notes-1.2.0.json', { name: 'notes', version: '1.2.0', tags: ['writing'] }, [skill('Notes', 'v1.2')], acme.privateKeyPem),
    publish('/notes-1.10.0.json', { name: 'notes', version: '1.10.0', tags: ['writing'] }, [skill('Notes', 'v1.10')], acme.privateKeyPem),
    publish('/drafts.json', { name: 'drafts', version: '0.1.0' }, [skill('Drafts')]),
    publish('/strange.json', { name: 'strange', version: '1.0.0' }, [skill('Strange')], stranger.privateKeyPem),
    publish('/elsewhere.json', { name: 'elsewhere', version: '1.0.0' }, [skill('Elsewhere')], other.privateKeyPem),
  ]);
  configure([ACME]);
  const { status, body } = await browse();
  expect(status).toBe(200);
  expect(body.registries).toEqual(['acme']);
  expect(body.errors).toEqual([]);
  const byName = Object.fromEntries(body.listings.map((l: any) => [l.name, l]));
  expect(Object.keys(byName).sort()).toEqual(['drafts', 'elsewhere', 'notes', 'strange']);
  expect(byName.notes).toMatchObject({ registry: 'acme', version: '1.10.0', olderVersions: ['1.2.0', '1.0.0'], installedVersion: null, updateAvailable: false, signature: { status: 'valid', publisher: 'Acme' } });
  expect(byName.drafts.signature.status).toBe('unsigned');
  expect(byName.strange.signature.status).toBe('unknown_key');
  // A trusted publisher, but not one this registry is trusted for.
  expect(byName.elsewhere.signature).toMatchObject({ status: 'unknown_key', detail: expect.stringMatching(/not a publisher trusted for this registry/) });
  await browse();
  expect(fake.requests.filter((r) => r === '/index.json')).toHaveLength(1);
  // Browsing downloads no bundle.
  expect(fake.requests).toEqual(['/index.json']);
});

test('search: every word, in name, description, tags, author or skill names; a tag filter', async () => {
  serveIndex([
    publish('/notes.json', { name: 'notes', version: '1.0.0', description: 'Meeting notes that people read', tags: ['writing'] }, [skill('Notes')], acme.privateKeyPem),
    publish('/deploy.json', { name: 'deploy', version: '1.0.0', description: 'Ship a release', tags: ['devops'] }, [skill('Deploy checklist')], acme.privateKeyPem),
  ]);
  configure([ACME]);
  const names = async (query: string) => (await browse(query)).body.listings.map((l: any) => l.name);
  expect(await names('?q=meeting%20read')).toEqual(['notes']);
  expect(await names('?q=checklist')).toEqual(['deploy']);
  expect(await names('?q=meeting%20checklist')).toEqual([]);
  expect(await names('?tag=DevOps')).toEqual(['deploy']);
  expect(await names('?q=acme')).toEqual(['deploy', 'notes']);
});

test('install: only through preview then install; signed by the registry publisher; recorded; an update is shown and not applied', async () => {
  serveIndex([publish('/notes-1.0.0.json', { name: 'notes', version: '1.0.0' }, [skill('Notes', 'version one')], acme.privateKeyPem)]);
  configure([ACME]);
  const before = await getDb().select().from(skills);
  const shown = await preview(source('notes', '1.0.0'));
  expect(shown.status).toBe(200);
  expect(shown.body).toMatchObject({
    source: 'registry', url: url('/notes-1.0.0.json'), registry: { registry: 'acme', name: 'notes', version: '1.0.0' },
    installable: true, refusal: null, signature: { status: 'valid', publisher: 'Acme', keyId: acme.keyId },
  });
  expect(shown.body.skills[0].skill.content).toBe('version one');
  expect(await getDb().select().from(skills)).toEqual(before);

  const done = await install(source('notes', '1.0.0'), shown.body.contentHash);
  expect(done.status).toBe(200);
  const [row] = await getDb().select().from(skills).where(eq(skills.id, done.body.created[0].id));
  expect(row).toMatchObject({ name: 'Notes', content: 'version one', userId: alice.id, isSystem: false });
  const [audit] = await auditRepository.findByResource('skill', row.id);
  expect(audit.details).toMatchObject({ op: 'skill_imported', source: 'registry', registry: 'acme', listing: 'notes', version: '1.0.0', url: url('/notes-1.0.0.json'), signature: 'valid', publisher: 'Acme' });
  expect((await browse()).body.listings[0]).toMatchObject({ installedVersion: '1.0.0', updateAvailable: false });

  // The registry publishes 1.1.0: shown as available, the installed skill untouched.
  serveIndex([
    publish('/notes-1.0.0.json', { name: 'notes', version: '1.0.0' }, [skill('Notes', 'version one')], acme.privateKeyPem),
    publish('/notes-1.1.0.json', { name: 'notes', version: '1.1.0' }, [skill('Notes', 'version two')], acme.privateKeyPem),
  ]);
  clearSkillRegistryCache();
  expect((await browse()).body.listings[0]).toMatchObject({ version: '1.1.0', installedVersion: '1.0.0', updateAvailable: true });
  const [still] = await getDb().select().from(skills).where(eq(skills.id, row.id));
  expect(still.content).toBe('version one');

  // Updating is a new preview and an explicit decision on the colliding skill.
  const next = await preview(source('notes', '1.1.0'));
  expect(next.body.skills[0].collision).toMatchObject({ id: row.id, kind: 'own', canReplace: true });
  expect((await install(source('notes', '1.1.0'), next.body.contentHash)).status).toBe(409);
  const replaced = await install(source('notes', '1.1.0'), next.body.contentHash, [{ name: 'Notes', action: 'replace', skillId: row.id }]);
  expect(replaced.status).toBe(200);
  expect((await getDb().select().from(skills).where(eq(skills.id, row.id)))[0].content).toBe('version two');
  expect((await browse()).body.listings[0]).toMatchObject({ installedVersion: '1.1.0', updateAvailable: false });
});

test('the downloaded bundle must hash to the index digest', async () => {
  serveIndex([publish('/notes.json', { name: 'notes', version: '1.0.0' }, [skill('Notes')], acme.privateKeyPem, { bundleSha256: sha('something else') })]);
  configure([ACME]);
  const refused = await preview(source('notes', '1.0.0'));
  expect(refused.status).toBe(400);
  expect(refused.body.error).toMatch(/hashes to sha256:[0-9a-f]{64}, not to the sha256:[0-9a-f]{64} the registry acme lists/);
  expect((await install(source('notes', '1.0.0'), sha('x'))).status).toBe(400);
  expect(await getDb().select().from(skills)).toEqual([]);
});

test('a matching digest is no substitute for the signature: a bad, missing or other-publisher signature is not installable', async () => {
  // A signature that does not verify, served with an index digest that matches it.
  const bundle = buildBundle([skill('Forged')], acme.privateKeyPem);
  const forged = JSON.stringify({ ...bundle, signature: { ...bundle.signature!, signature: buildBundle([skill('Other')], acme.privateKeyPem).signature!.signature } });
  fake.files.set('/forged.json', { body: forged });
  serveIndex([
    { name: 'forged', version: '1.0.0', description: 'forged', tags: [], author: null, publisherKeyId: acme.keyId, skills: ['Forged'], bundleUrl: url('/forged.json'), bundleSha256: sha(forged), contentHash: bundle.contentHash },
    publish('/drafts.json', { name: 'drafts', version: '1.0.0' }, [skill('Drafts')]),
    publish('/elsewhere.json', { name: 'elsewhere', version: '1.0.0' }, [skill('Elsewhere')], other.privateKeyPem),
  ]);
  configure([ACME]);

  const bad = await preview(source('forged', '1.0.0'));
  expect(bad.body).toMatchObject({ installable: false, signature: { status: 'invalid' }, refusal: expect.stringMatching(/signature is invalid/) });
  expect((await install(source('forged', '1.0.0'), bad.body.contentHash)).status).toBe(400);

  const unsigned = await preview(source('drafts', '1.0.0'));
  expect(unsigned.body).toMatchObject({ installable: false, signature: { status: 'unsigned' }, refusal: expect.stringMatching(/fetched from the registry acme must carry a valid signature/) });
  expect((await install(source('drafts', '1.0.0'), unsigned.body.contentHash)).status).toBe(400);

  const elsewhere = await preview(source('elsewhere', '1.0.0'));
  expect(elsewhere.body).toMatchObject({ installable: false, signature: { status: 'unknown_key', detail: expect.stringMatching(/not one of this registry's publishers \(Acme\)/) } });
  expect((await install(source('elsewhere', '1.0.0'), elsewhere.body.contentHash)).status).toBe(400);
  expect(await getDb().select().from(skills)).toEqual([]);
});

test('a bundle that is not what its listing says is refused', async () => {
  serveIndex([
    publish('/a.json', { name: 'renamed', version: '1.0.0' }, [skill('Real name')], acme.privateKeyPem, { skills: ['Listed name'] }),
    publish('/b.json', { name: 'claims-unsigned', version: '1.0.0' }, [skill('B')], acme.privateKeyPem, { publisherKeyId: null }),
  ]);
  configure([ACME]);
  expect((await preview(source('renamed', '1.0.0'))).body.error).toMatch(/does not match its listing .*its skills are not the ones listed/);
  expect((await preview(source('claims-unsigned', '1.0.0'))).body.error).toMatch(/does not match its listing .*listed as unsigned/);
});

test('an oversized or malformed index is refused and reported; other registries still list', async () => {
  fake.files.set('/big.json', { body: Buffer.alloc(MAX_SKILL_INDEX_BYTES + 10, 0x20) });
  fake.files.set('/broken.json', { body: '{"format":"octipus-skill-index","version":9,"entries":[]}' });
  serveIndex([publish('/notes.json', { name: 'notes', version: '1.0.0' }, [skill('Notes')], acme.privateKeyPem)]);
  configure([ACME, { name: 'big', url: url('/big.json'), publishers: ['Acme'] }, { name: 'broken', url: url('/broken.json'), publishers: ['Acme'] }]);
  const { body } = await browse();
  expect(body.listings.map((l: any) => l.name)).toEqual(['notes']);
  expect(body.errors).toEqual([
    { registry: 'big', error: expect.stringMatching(/larger than 1048576 bytes/) },
    { registry: 'broken', error: expect.stringMatching(/newer than this Octipus reads/) },
  ]);
});

test('a bundle URL cannot reach a private address: listed literally (skipped) or by redirect (refused by the guard)', async () => {
  const notes = publish('/notes.json', { name: 'notes', version: '1.0.0' }, [skill('Notes')], acme.privateKeyPem);
  fake.files.set('/hop.json', { status: 302, location: `http://127.0.0.1:${fake.port}/notes.json` });
  fake.files.set('/hop-https.json', { status: 302, location: 'https://127.0.0.1/notes.json' });
  serveIndex([
    { ...notes, name: 'literal', bundleUrl: 'https://10.0.0.8/notes.json' },
    { ...notes, name: 'metadata', bundleUrl: 'https://169.254.169.254/latest/meta-data' },
    { ...notes, name: 'hop', bundleUrl: url('/hop.json') },
    { ...notes, name: 'hop-https', bundleUrl: url('/hop-https.json') },
  ]);
  configure([ACME]);
  const { body } = await browse();
  expect(body.listings.map((l: any) => l.name)).toEqual(['hop', 'hop-https']);
  expect(body.problems.map((p: any) => p.problem).join('\n')).toMatch(/private or reserved address \(10\.0\.0\.8\)[\s\S]*private or reserved address \(169\.254\.169\.254\)/);
  expect((await preview(source('literal', '1.0.0'))).status).toBe(404);
  expect((await preview(source('hop', '1.0.0'))).body.error).toMatch(/could not be downloaded: it redirects somewhere that is not followed/);
  expect((await preview(source('hop-https', '1.0.0'))).body.error).toMatch(/could not be downloaded: it resolves to a private or reserved address/);
  expect(fake.requests).not.toContain('/notes.json');
});

test('index URLs (and their tokens) never reach a caller: failures name the registry and the class only', async () => {
  fake.files.set('/hop-index.json', { status: 302, location: 'https://127.0.0.1/index.json?token=inner-s3cret' });
  configure([
    { name: 'gone', url: url('/missing.json?token=s3cret'), publishers: ['Acme'] },
    { name: 'inward', url: url('/hop-index.json?key=s3cret'), publishers: ['Acme'] },
  ]);
  const { body } = await browse();
  expect(body.errors).toEqual([
    { registry: 'gone', error: 'the server answered HTTP 404' },
    { registry: 'inward', error: 'it resolves to a private or reserved address (refused)' },
  ]);
  const text = JSON.stringify(body);
  for (const leak of ['s3cret', REGISTRY_HOST, 'missing.json', '127.0.0.1']) expect(text).not.toContain(leak);
  const refused = await preview(source('notes', '1.0.0', 'gone'));
  expect(refused.body.error).toBe('The registry gone could not be read: the server answered HTTP 404');

  // A bundle that cannot be fetched: no bundle URL either.
  serveIndex([{ ...publish('/notes.json', { name: 'notes', version: '1.0.0' }, [skill('Notes')], acme.privateKeyPem), bundleUrl: url('/gone.json?sig=s3cret') }]);
  configure([ACME]);
  const missing = await preview(source('notes', '1.0.0'));
  expect(missing.body.error).toBe('The bundle of notes 1.0.0 from the registry acme could not be downloaded: the server answered HTTP 404');
});

test('a read-only token cannot make the server download; registry previews are limited per person', async () => {
  serveIndex([publish('/notes.json', { name: 'notes', version: '1.0.0' }, [skill('Notes')], acme.privateKeyPem)]);
  configure([ACME]);
  scopes = ['api:read'];
  expect((await preview(source('notes', '1.0.0'))).status).toBe(403);
  expect((await preview({ url: url('/notes.json') })).status).toBe(403);
  expect(fake.requests).toEqual([]);
  scopes = undefined;
  for (let i = 0; i < REGISTRY_FETCH_LIMIT; i++) expect((await preview(source('notes', '1.0.0'))).status).toBe(200);
  const limited = await preview(source('notes', '1.0.0'));
  expect(limited.status).toBe(429);
  // One index read and one bundle download served every preview.
  expect(fake.requests).toEqual(['/index.json', '/notes.json']);
});

test('concurrent reads of one index share a request', async () => {
  serveIndex([publish('/notes.json', { name: 'notes', version: '1.0.0' }, [skill('Notes')], acme.privateKeyPem)]);
  configure([ACME]);
  await Promise.all([browse(), browse(), browse()]);
  expect(fake.requests).toEqual(['/index.json']);
});

test('an index that swaps the content of a version between preview and install installs nothing', async () => {
  serveIndex([publish('/notes.json', { name: 'notes', version: '1.0.0' }, [skill('Notes', 'reviewed')], acme.privateKeyPem)]);
  configure([ACME]);
  const shown = await preview(source('notes', '1.0.0'));
  expect(shown.body.installable).toBe(true);
  serveIndex([publish('/notes-swapped.json', { name: 'notes', version: '1.0.0' }, [skill('Notes', 'something else')], acme.privateKeyPem)]);
  clearSkillRegistryCache();
  const swapped = await install(source('notes', '1.0.0'), shown.body.contentHash);
  expect(swapped.status).toBe(409);
  expect(swapped.body.error).toMatch(/not to the sha256:[0-9a-f]{64} that was previewed/);
  expect(await getDb().select().from(skills)).toEqual([]);
});

/** Install `version` of notes with `content`, replacing the caller's copy when there is one. */
async function installNotes(version: string, content: string, entries: unknown[]) {
  serveIndex(entries);
  clearSkillRegistryCache();
  const shown = await preview(source('notes', version));
  const own = shown.body.skills[0].collision;
  const done = await install(source('notes', version), shown.body.contentHash, own ? [{ name: 'Notes', action: 'replace', skillId: own.id }] : undefined);
  expect(done.status).toBe(200);
  return { shown, done };
}

test('a signature does not cover the version: a relabelled old bundle is no update, and the preview says so', async () => {
  configure([ACME]);
  const v1 = publish('/notes-1.json', { name: 'notes', version: '1.0.0' }, [skill('Notes', 'one')], acme.privateKeyPem);
  const v2 = publish('/notes-2.json', { name: 'notes', version: '1.1.0' }, [skill('Notes', 'two')], acme.privateKeyPem);
  await installNotes('1.0.0', 'one', [v1]);
  const second = await installNotes('1.1.0', 'two', [v1, v2]);
  expect(second.shown.body.registry.installed).toEqual({ version: '1.0.0', contentHash: v1.contentHash });

  // The registry relists 1.0.0's content as 9.9.9 (a rollback).
  serveIndex([v1, v2, { ...v1, version: '9.9.9' }]);
  clearSkillRegistryCache();
  expect((await browse()).body.listings[0]).toMatchObject({ version: '9.9.9', installedVersion: '1.1.0', installedContentHash: v2.contentHash, updateAvailable: false });
  const rollback = await preview(source('notes', '9.9.9'));
  expect(rollback.body.warnings.join('\n')).toMatch(/Possible rollback: this exact content was installed before as 1\.0\.0/);

  // The installed content relabelled higher: no update either.
  serveIndex([v1, v2, { ...v2, version: '2.0.0' }]);
  clearSkillRegistryCache();
  expect((await browse()).body.listings[0]).toMatchObject({ version: '2.0.0', updateAvailable: false });
  expect((await preview(source('notes', '2.0.0'))).body.warnings.join('\n')).toMatch(/content you installed as 1\.1\.0/);

  // Other content that is not newer.
  serveIndex([publish('/notes-0.json', { name: 'notes', version: '0.9.0' }, [skill('Notes', 'zero')], acme.privateKeyPem)]);
  clearSkillRegistryCache();
  expect((await browse()).body.listings[0]).toMatchObject({ version: '0.9.0', updateAvailable: false });
  expect((await preview(source('notes', '0.9.0'))).body.warnings.join('\n')).toMatch(/You installed 1\.1\.0 .*other content that is not newer/);
});

test('an install record follows the registry URL, and lets go of a skill replaced by another import', async () => {
  const v1 = publish('/notes-1.json', { name: 'notes', version: '1.0.0' }, [skill('Notes', 'one')], acme.privateKeyPem);
  configure([ACME]);
  const { done } = await installNotes('1.0.0', 'one', [v1]);
  expect((await browse()).body.listings[0].installedVersion).toBe('1.0.0');

  // The same name now points at another index: what was installed from the old one does not carry over.
  serveIndex([v1], '/other-index.json');
  configure([{ ...ACME, url: url('/other-index.json') }]);
  expect((await browse()).body.listings[0].installedVersion).toBeNull();
  configure([ACME]);
  expect((await browse()).body.listings[0].installedVersion).toBe('1.0.0');

  // Replaced by an uploaded bundle: no longer installed from the registry.
  const upload = JSON.stringify(buildBundle([skill('Notes', 'my own')]));
  const shown = await preview({ bundle: upload });
  expect((await install({ bundle: upload }, shown.body.contentHash, [{ name: 'Notes', action: 'replace', skillId: done.body.created[0].id }])).status).toBe(200);
  expect((await browse()).body.listings[0]).toMatchObject({ installedVersion: null, updateAvailable: false });
});
