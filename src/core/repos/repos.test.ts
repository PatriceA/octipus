import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildRepoEdges, dependenciesOf, dependentsOf, type RepoGraphNode } from './graph';
import { parseCargoToml, parseGoMod, parsePackageJson, parsePyproject } from './manifests';
import { buildRepoMapText, findRepoRoots, inferRepoKind, scanRepoAt, scanRoots } from './scanner';

describe('manifests', () => {
  test('parsePackageJson extracts name, deps, and typescript language', () => {
    const parsed = parsePackageJson(JSON.stringify({
      name: '@acme/app',
      dependencies: { '@acme/core': '^2.1.0', react: '^18.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    }));
    expect(parsed?.packageName).toBe('@acme/app');
    expect(parsed?.language).toBe('typescript');
    expect(parsed?.dependencies.map((d) => d.name).sort()).toEqual(['@acme/core', 'react', 'typescript']);
  });

  test('parsePackageJson returns null on malformed JSON', () => {
    expect(parsePackageJson('{ not json')).toBeNull();
  });

  test('parseCargoToml extracts package name and dependencies', () => {
    const parsed = parseCargoToml([
      '[package]',
      'name = "acme-core"',
      'version = "0.1.0"',
      '',
      '[dependencies]',
      'serde = "1.0"',
      'tokio = { version = "1.35", features = ["full"] }',
    ].join('\n'));
    expect(parsed?.packageName).toBe('acme-core');
    expect(parsed?.language).toBe('rust');
    const deps = Object.fromEntries(parsed!.dependencies.map((d) => [d.name, d.version]));
    expect(deps.serde).toBe('1.0');
    expect(deps.tokio).toBe('1.35');
  });

  test('parseGoMod extracts module and require block', () => {
    const parsed = parseGoMod([
      'module github.com/acme/lib',
      'go 1.21',
      'require (',
      '\tgithub.com/stretchr/testify v1.8.0',
      '\tgithub.com/acme/util v0.2.0 // indirect',
      ')',
    ].join('\n'));
    expect(parsed?.packageName).toBe('github.com/acme/lib');
    expect(parsed?.dependencies.map((d) => d.name).sort()).toEqual([
      'github.com/acme/util',
      'github.com/stretchr/testify',
    ]);
  });

  test('parsePyproject handles PEP 621 and poetry', () => {
    const pep = parsePyproject([
      '[project]',
      'name = "acme-svc"',
      'dependencies = ["requests>=2.0", "rich"]',
    ].join('\n'));
    expect(pep?.packageName).toBe('acme-svc');
    expect(pep?.dependencies.map((d) => d.name).sort()).toEqual(['requests', 'rich']);

    const poetry = parsePyproject([
      '[tool.poetry]',
      'name = "acme-poetry"',
      '[tool.poetry.dependencies]',
      'python = "^3.11"',
      'httpx = "^0.27"',
    ].join('\n'));
    expect(poetry?.packageName).toBe('acme-poetry');
    // python is excluded; httpx kept
    expect(poetry?.dependencies.map((d) => d.name)).toEqual(['httpx']);
  });

  test('parsePyproject: optional-dependencies before dependencies does not hijack the match', () => {
    // Regression: an unanchored regex matched `dependencies` inside
    // `optional-dependencies` when it appeared first.
    const parsed = parsePyproject([
      '[project]',
      'name = "acme"',
      'optional-dependencies = ["extra-pkg>=9"]',
      'dependencies = ["requests>=2.0"]',
    ].join('\n'));
    expect(parsed?.dependencies.map((d) => d.name)).toEqual(['requests']);
  });

  test('parsePyproject: PEP 508 extras are stripped from the version', () => {
    const parsed = parsePyproject([
      '[project]',
      'name = "acme"',
      'dependencies = ["requests[security]>=2.0"]',
    ].join('\n'));
    expect(parsed?.dependencies).toEqual([{ name: 'requests', version: '>=2.0', manifest: 'pyproject.toml' }]);
  });
});

describe('dependency graph', () => {
  const nodes: RepoGraphNode[] = [
    { id: 'lib', name: 'core', packageName: '@acme/core', dependencies: [] },
    { id: 'util', name: 'util', packageName: '@acme/util', dependencies: [] },
    { id: 'app', name: 'app', packageName: 'app', dependencies: [
      { name: '@acme/core', version: '^2.0', manifest: 'package.json' },
      { name: '@acme/core', version: '^2.0', manifest: 'package.json' }, // dup → one edge
      { name: 'react', version: '^18', manifest: 'package.json' },       // external → no edge
    ] },
  ];

  test('buildRepoEdges links consumers to in-registry providers only', () => {
    const edges = buildRepoEdges(nodes);
    expect(edges).toEqual([{ from: 'app', to: 'lib', via: '@acme/core', version: '^2.0' }]);
  });

  test('dependentsOf and dependenciesOf', () => {
    expect(dependentsOf('lib', nodes).map((n) => n.id)).toEqual(['app']);
    expect(dependenciesOf('app', nodes).map((n) => n.id)).toEqual(['lib']);
    expect(dependentsOf('util', nodes)).toEqual([]);
  });

  test('a repo cannot depend on itself', () => {
    const selfdep: RepoGraphNode[] = [
      { id: 'a', name: 'a', packageName: 'a', dependencies: [{ name: 'a', version: '1', manifest: 'package.json' }] },
    ];
    expect(buildRepoEdges(selfdep)).toEqual([]);
  });
});

describe('scanner pure helpers', () => {
  test('inferRepoKind classifies product/library/infra/unknown', () => {
    const reactDeps = [{ name: 'react', version: '^18', manifest: 'package.json' }];
    expect(inferRepoKind([{ manifest: 'package.json', language: 'typescript', dependencies: reactDeps }], reactDeps, [])).toBe('product');
    expect(inferRepoKind([{ manifest: 'package.json', packageName: '@acme/lib', language: 'typescript', dependencies: [] }], [], [])).toBe('library');
    expect(inferRepoKind([], [], ['main.tf'])).toBe('infra');
    expect(inferRepoKind([], [], ['README.md'])).toBe('unknown');
  });

  test('buildRepoMapText renders a compact digest', () => {
    const text = buildRepoMapText({
      topDirs: ['src', 'test'],
      entryPoints: ['src/index.ts'],
      commands: { test: 'bun test', build: 'tsc' },
      languages: ['typescript'],
    });
    expect(text).toContain('Languages: typescript');
    expect(text).toContain('Top-level: src, test');
    expect(text).toContain('Entry points: src/index.ts');
    expect(text).toContain('test (`bun test`)');
  });
});

describe('scanner integration (temp fixture)', () => {
  test('scans a suite of sibling repos and derives edges', () => {
    const root = mkdtempSync(join(tmpdir(), 'octi-repos-'));
    // library
    mkdirSync(join(root, 'core'));
    writeFileSync(join(root, 'core', 'package.json'), JSON.stringify({ name: '@acme/core', version: '1.0.0' }));
    mkdirSync(join(root, 'core', 'src'));
    writeFileSync(join(root, 'core', 'src', 'index.ts'), 'export const x = 1;');
    // product consuming the library
    mkdirSync(join(root, 'app'));
    writeFileSync(join(root, 'app', 'package.json'), JSON.stringify({
      name: 'app',
      dependencies: { '@acme/core': '^1.0.0', react: '^18.0.0' },
      scripts: { test: 'bun test', build: 'next build' },
    }));
    writeFileSync(join(root, 'app', 'AGENTS.md'), '# App guide');

    expect(findRepoRoots([root]).sort()).toEqual([join(root, 'app'), join(root, 'core')].sort());

    const results = scanRoots([root]);
    const core = results.find((r) => r.name === 'core');
    const app = results.find((r) => r.name === 'app');
    expect(core?.kind).toBe('library');
    expect(core?.packageName).toBe('@acme/core');
    expect(app?.kind).toBe('product');
    expect(app?.hasAgentsMd).toBe(true);
    expect(app?.repoMap).toContain('test (`bun test`)');

    // Edge: app → core
    const nodes: RepoGraphNode[] = results.map((r) => ({
      id: r.name, name: r.name, packageName: r.packageName, dependencies: r.dependencies,
    }));
    const edges = buildRepoEdges(nodes);
    expect(edges).toEqual([{ from: 'app', to: 'core', via: '@acme/core', version: '^1.0.0' }]);
  });

  test('scanRepoAt returns null for a non-repo directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'octi-empty-'));
    expect(scanRepoAt(root)).toBeNull();
  });
});
