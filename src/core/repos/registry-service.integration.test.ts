import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { getConfig } from '@/config';
import { WorkspaceFS } from '@/security/workspace-fs';
import { repoRegistryRepository } from '@/db/repositories/repo-registry-repository';
import { scanUserRepos, loadRepoGraph, resolveRepo, indexRepoKnowledge } from './registry-service';
import { findSymbols } from './symbols';
import { resolveRepoScope } from '@/tools/knowledge';

const knowledge = vi.hoisted(() => ({ records: new Map<string, string>(), unavailable: false }));
vi.mock('@/core/rag/embeddings', () => ({
  sha256Hex: (content: string) => createHash('sha256').update(content).digest('hex'),
  getEmbeddingService: () => {
    if (knowledge.unavailable) throw new Error('No embedding model configured');
    return {
      isFileIndexed: async (purpose: string, id: string, content: string) => knowledge.records.get(`${purpose}:${id}`) === content,
      deleteBySource: async (purpose: string, id: string) => Number(knowledge.records.delete(`${purpose}:${id}`)),
      indexText: async (purpose: string, id: string, content: string) => { knowledge.records.set(`${purpose}:${id}`, content); },
    };
  },
}));

const alice = randomUUID();
const bob = randomUUID();
let suite: string;
let second: string;
let originalWorkspace: ReturnType<typeof getConfig>['workspace'];
function repo(parent: string, name: string, pkg: string, dependencies: Record<string, string> = {}) {
  const path = join(parent, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name: pkg, dependencies }));
  writeFileSync(join(path, 'AGENTS.md'), `Guide for ${pkg}`);
  writeFileSync(join(path, 'index.ts'), `export function ${name.replace(/\W/g, '')}Handler() { return 1; }\n`);
  return path;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'native-repos-db-'));
  process.env.MASTER_KEY ??= randomUUID();
  process.env.JWT_SECRET ??= randomUUID();
  process.env.SESSION_SECRET ??= randomUUID();
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username) VALUES ('${alice}', 'native-alice'), ('${bob}', 'native-bob')`);
  originalWorkspace = { ...getConfig().workspace };
});
beforeEach(async () => {
  const { executeRaw } = await import('@/db/postgres');
  await executeRaw('DELETE FROM workspace_repos');
  const root = mkdtempSync(join(tmpdir(), 'native-repos-suite-'));
  suite = join(root, 'suite'); second = join(root, 'other');
  mkdirSync(suite); mkdirSync(second);
  getConfig().workspace.rootPath = join(root, 'workspaces');
  getConfig().workspace.additionalPaths = [suite, second];
  knowledge.records.clear(); knowledge.unavailable = false;
});
afterAll(async () => {
  Object.assign(getConfig().workspace, originalWorkspace);
  const { closeDb } = await import('@/db/postgres'); await closeDb();
});

describe('native multi-repo flow without external code search', () => {
  test('Java Maven and Gradle repositories connect by coordinates and expose Java symbols', async () => {
    const corePath = join(suite, 'java-core');
    const appPath = join(suite, 'java-app');
    mkdirSync(join(corePath, 'src/main/java'), { recursive: true });
    mkdirSync(join(appPath, 'src/main/java'), { recursive: true });
    writeFileSync(join(corePath, 'pom.xml'), `<project xmlns="http://maven.apache.org/POM/4.0.0">
      <modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>core</artifactId>
      <version>1.0</version></project>`);
    writeFileSync(join(corePath, 'mvnw'), '#!/bin/sh\nexit 99\n');
    writeFileSync(join(corePath, 'src/main/java/Core.java'), 'public class Core { public void execute() {} }');
    writeFileSync(join(appPath, 'settings.gradle.kts'), 'rootProject.name = "app"');
    writeFileSync(join(appPath, 'build.gradle.kts'), `plugins { java }
      group = "com.example"
      dependencies { implementation("com.example:core:1.0") }`);
    writeFileSync(join(appPath, 'gradlew'), '#!/bin/sh\nexit 99\n');
    writeFileSync(join(appPath, 'src/main/java/App.java'), 'public class App {}');
    await scanUserRepos(alice);
    const graph = await loadRepoGraph(alice);
    const core = resolveRepo(graph.repos, 'java-core')!;
    const app = resolveRepo(graph.repos, 'java-app')!;
    expect(core.packageName).toBe('com.example:core');
    expect(app.packageName).toBe('com.example:app');
    expect(core.languages).toEqual(['java']);
    expect(app.languages).toEqual(['java']);
    expect(graph.edges).toEqual([{ from: app.id, to: core.id, via: 'com.example:core', version: '1.0' }]);
    expect(findSymbols(core.symbolIndex!, 'Core')).toMatchObject([
      { name: 'Core', kind: 'class', path: 'src/main/java/Core.java', line: 1 },
      { name: 'Core.execute', kind: 'method', path: 'src/main/java/Core.java', line: 1 },
    ]);
    expect(core.repoMap).toContain('./mvnw test');
    expect(app.repoMap).toContain('./gradlew build');
  });

  test('HTTP scan/list/detail preserve ownership and reject revoked roots', async () => {
    const { Elysia } = await import('@/api/http');
    const { workspaceRoutes } = await import('@/api/routes/workspace');
    const { principalFromUser } = await import('@/security/principal');
    const appFor = (id: string) => {
      const user = { id, username: 'native-test', isAdmin: false };
      return new Elysia().derive(() => ({ user, session: null, principal: principalFromUser(user) }))
        .group('/api', app => app.use(workspaceRoutes));
    };
    repo(suite, 'core', '@demo/core');
    repo(second, 'duplicate', '@demo/core');
    repo(suite, 'app', '@demo/app', { '@demo/core': '*' });
    const app = appFor(alice);
    const scan = await app.handle(new Request('http://localhost/api/workspace/repos/scan', { method: 'POST' }));
    expect(scan.status).toBe(200);
    expect(await scan.json()).toMatchObject({ scanned: 3 });
    const listed = await app.handle(new Request('http://localhost/api/workspace/repos'));
    const body = await listed.json();
    expect(body.edges).toEqual([]);
    expect(body.ambiguousPackages).toEqual(['@demo/core']);
    const core = body.repos.find((entry: { name: string }) => entry.name === 'core');
    const url = `http://localhost/api/workspace/repos/${core.id}`;
    expect((await app.handle(new Request(url))).status).toBe(200);
    expect((await appFor(bob).handle(new Request(url))).status).toBe(404);
    getConfig().workspace.additionalPaths = [second];
    expect((await app.handle(new Request(url))).status).toBe(404);
  });

  test('scans, persists, derives dependency edges and finds symbols without an embedding model', async () => {
    knowledge.unavailable = true;
    repo(suite, 'core', '@demo/core');
    repo(suite, 'app', '@demo/app', { '@demo/core': '^1.0.0' });
    const scanned = await scanUserRepos(alice);
    expect(scanned).toHaveLength(2);
    const graph = await loadRepoGraph(alice);
    const core = resolveRepo(graph.repos, 'core')!;
    const app = resolveRepo(graph.repos, 'app')!;
    expect(graph.edges).toEqual([{ from: app.id, to: core.id, via: '@demo/core', version: '^1.0.0' }]);
    expect(core.symbolIndex).not.toBeNull();
    expect(findSymbols(core.symbolIndex!, 'coreHandler')).toMatchObject([{ path: 'index.ts', line: 1, name: 'coreHandler' }]);
    expect(await repoRegistryRepository.getById(bob, core.id)).toBeNull();
    expect((await loadRepoGraph(bob)).repos).toEqual([]);
  });

  test('rescanning updates symbols and dependencies in place and removes deleted guide knowledge', async () => {
    const corePath = repo(suite, 'core', '@demo/core');
    const appPath = repo(suite, 'app', '@demo/app', { '@demo/core': '*' });
    const first = await scanUserRepos(alice);
    const core = resolveRepo(first, 'core')!;
    expect(knowledge.records.has(`document:repo:${core.id}:agents`)).toBe(true);
    writeFileSync(join(corePath, 'index.ts'), 'export function replacement() {}\n');
    writeFileSync(join(appPath, 'package.json'), JSON.stringify({ name: '@demo/app' }));
    rmSync(join(corePath, 'AGENTS.md'));
    const updated = await scanUserRepos(alice);
    const refreshed = resolveRepo(updated, 'core')!;
    expect(refreshed.id).toBe(core.id);
    expect(findSymbols(refreshed.symbolIndex!, 'coreHandler')).toHaveLength(0);
    expect(findSymbols(refreshed.symbolIndex!, 'replacement')).toHaveLength(1);
    expect((await loadRepoGraph(alice)).edges).toHaveLength(0);
    expect(knowledge.records.has(`document:repo:${core.id}:agents`)).toBe(false);
    expect([...knowledge.records.values()].some(content => content.includes('export function'))).toBe(false);
  });

  test('removed or no-longer-exposed repositories are hidden without returning stale source maps', async () => {
    const removed = repo(suite, 'removed', 'removed');
    repo(second, 'revoked', 'revoked');
    await scanUserRepos(alice);
    rmSync(removed, { recursive: true });
    getConfig().workspace.additionalPaths = [suite];
    expect((await loadRepoGraph(alice)).repos).toHaveLength(0);
    expect(await scanUserRepos(alice)).toHaveLength(0);
  });

  test('private per-user repositories stay isolated even after both users scan', async () => {
    const aRoot = WorkspaceFS.forAgent({ userId: alice }); aRoot.ensureRootSync();
    const bRoot = WorkspaceFS.forAgent({ userId: bob }); bRoot.ensureRootSync();
    repo(aRoot.root, 'private', '@alice/private'); repo(bRoot.root, 'private', '@bob/private');
    await scanUserRepos(alice); await scanUserRepos(bob);
    expect((await loadRepoGraph(alice)).repos.map(row => row.packageName)).toEqual(['@alice/private']);
    expect((await loadRepoGraph(bob)).repos.map(row => row.packageName)).toEqual(['@bob/private']);
  });

  test('duplicate names require an id/path and explicit knowledge filters never broaden on typos', async () => {
    repo(suite, 'same', '@demo/one'); repo(second, 'same', '@demo/two');
    const rows = await scanUserRepos(alice);
    expect(() => resolveRepo(rows, 'same')).toThrow(/ambiguous/);
    expect(resolveRepo(rows, rows[0].id)?.id).toBe(rows[0].id);
    expect(resolveRepo(rows, rows[0].rootPath)?.id).toBe(rows[0].id);
    await expect(resolveRepoScope('missing', alice)).rejects.toThrow(/Unknown or unavailable/);
    await expect(resolveRepoScope(`${rows[0].id},missing`, alice)).rejects.toThrow(/Unknown or unavailable/);
    await expect(resolveRepoScope('same', alice)).rejects.toThrow(/ambiguous/);
    await expect(resolveRepoScope(rows[0].id, undefined)).rejects.toThrow(/authenticated/);
    expect(await resolveRepoScope(`${rows[0].id},${rows[0].id}`, alice)).toMatchObject({ repoIds: [rows[0].id], allowedRepoIds: expect.arrayContaining(rows.map(row => row.id)) });
    expect(await resolveRepoScope(undefined, alice)).toEqual({ allowedRepoIds: rows.map(row => row.id) });
    expect(await resolveRepoScope(undefined, bob)).toEqual({ allowedRepoIds: [] });
    getConfig().workspace.additionalPaths = [];
    expect(await resolveRepoScope(undefined, alice)).toEqual({ allowedRepoIds: [] });
  });

  test('a symlinked AGENTS guide is not copied into knowledge', async () => {
    const path = repo(suite, 'core', 'core');
    const rows = await scanUserRepos(alice);
    const row = resolveRepo(rows, 'core')!;
    const outside = join(second, 'secret.md'); writeFileSync(outside, 'private guide');
    rmSync(join(path, 'AGENTS.md')); symlinkSync(outside, join(path, 'AGENTS.md'));
    await indexRepoKnowledge(row, alice);
    expect(knowledge.records.has(`document:repo:${row.id}:agents`)).toBe(false);
  });
});
