import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildRepoEdges, dependenciesOf, dependentsOf, findAmbiguousPackages, type RepoGraphNode } from './graph';
import { parseCargoToml, parseGoMod, parsePackageJson, parsePubspec, parsePyproject } from './manifests';
import { buildRepoMapText, findRepoRoots, inferRepoKind, isRepoRoot, scanRepoAt, scanRoots } from './scanner';

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
    expect(parsePackageJson('null')).toBeNull();
    expect(parsePackageJson('[]')).toBeNull();
  });

  test('parsePackageJson resolves npm aliases and ignores malformed dependency values', () => {
    const parsed = parsePackageJson(JSON.stringify({
      dependencies: {
        compat: 'npm:@acme/core@^2.0.0',
        invalid: { version: '1' },
      },
      devDependencies: { '@acme/core': '^3.0.0' },
    }));
    expect(parsed?.dependencies).toEqual([
      { name: '@acme/core', version: '^2.0.0', manifest: 'package.json' },
    ]);
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

  test('parseCargoToml handles quoted comments, renamed crates, and target dependencies', () => {
    const parsed = parseCargoToml([
      '[package]',
      'name = "rust#pkg"',
      '[dependencies]',
      'compat = { package = "real-crate", version = "2" }',
      '[target.\'cfg(unix)\'.dependencies]',
      'nix = "0.29"',
    ].join('\n'));
    expect(parsed?.packageName).toBe('rust#pkg');
    expect(parsed?.dependencies).toEqual([
      { name: 'real-crate', version: '2', manifest: 'Cargo.toml' },
      { name: 'nix', version: '0.29', manifest: 'Cargo.toml' },
    ]);
    expect(parseCargoToml('[package\nname = "broken"')).toBeNull();
    expect(parseCargoToml('unrelated = true')).toBeNull();
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

  test('parseGoMod rejects missing modules and unterminated require blocks', () => {
    expect(parseGoMod('require example.com/lib v1.0.0')).toBeNull();
    expect(parseGoMod('module example.com/app\nrequire (\nexample.com/lib v1.0.0')).toBeNull();
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

  test('parsePyproject preserves comma constraints and includes optional and Poetry group deps', () => {
    const pep = parsePyproject([
      '[project]',
      'name = "acme"',
      'dependencies = ["core>=1,<2"]',
      '[project.optional-dependencies]',
      'test = ["pytest>=8"]',
    ].join('\n'));
    expect(pep?.dependencies).toEqual([
      { name: 'core', version: '>=1,<2', manifest: 'pyproject.toml' },
      { name: 'pytest', version: '>=8', manifest: 'pyproject.toml' },
    ]);

    const poetry = parsePyproject([
      '[tool.poetry]',
      'name = "acme"',
      '[tool.poetry.group.dev.dependencies]',
      'ruff = "^0.6"',
    ].join('\n'));
    expect(poetry?.dependencies).toEqual([
      { name: 'ruff', version: '^0.6', manifest: 'pyproject.toml' },
    ]);
    expect(parsePyproject('[project\nname = "broken"')).toBeNull();
  });

  test('parsePubspec extracts Dart package identity and local dependencies', () => {
    const parsed = parsePubspec([
      'name: mobile_app',
      'dependencies:',
      '  flutter:',
      '    sdk: flutter',
      '  shared_core:',
      '    path: ../shared_core',
      'dev_dependencies:',
      '  test: ^1.25.0',
    ].join('\n'));
    expect(parsed?.packageName).toBe('mobile_app');
    expect(parsed?.language).toBe('dart');
    expect(parsed?.dependencies).toEqual([
      { name: 'flutter', version: 'sdk:flutter', manifest: 'pubspec.yaml' },
      { name: 'shared_core', version: 'path:../shared_core', manifest: 'pubspec.yaml' },
      { name: 'test', version: '^1.25.0', manifest: 'pubspec.yaml' },
    ]);
    expect(parsePubspec('name: [unterminated')).toBeNull();
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

  test('duplicate package providers are reported and do not create arbitrary edges', () => {
    const duplicateNodes: RepoGraphNode[] = [
      { id: 'lib-a', name: 'lib-a', packageName: '@acme/core', dependencies: [] },
      { id: 'lib-b', name: 'lib-b', packageName: '@acme/core', dependencies: [] },
      { id: 'app', name: 'app', packageName: 'app', dependencies: [
        { name: '@acme/core', version: '^1', manifest: 'package.json' },
      ] },
    ];
    expect(findAmbiguousPackages(duplicateNodes)).toEqual(['@acme/core']);
    expect(buildRepoEdges(duplicateNodes)).toEqual([]);
  });

  test('Python package spelling is normalized and aliases to one provider collapse', () => {
    const pythonNodes: RepoGraphNode[] = [
      { id: 'lib', name: 'lib', packageName: 'Acme_Core', dependencies: [] },
      { id: 'app', name: 'app', packageName: 'app', dependencies: [
        { name: 'acme-core', version: '>=1', manifest: 'pyproject.toml' },
        { name: 'acme.core', version: '>=1', manifest: 'pyproject.toml' },
      ] },
    ];
    expect(buildRepoEdges(pythonNodes)).toEqual([
      { from: 'app', to: 'lib', via: 'acme-core', version: '>=1' },
    ]);
  });

  test('Python exact spelling stays unlinked when a normalized alias is ambiguous', () => {
    const pythonNodes: RepoGraphNode[] = [
      { id: 'hyphen', name: 'hyphen', packageName: 'foo-bar', dependencies: [] },
      { id: 'underscore', name: 'underscore', packageName: 'foo_bar', dependencies: [] },
      { id: 'app', name: 'app', packageName: 'app', dependencies: [
        { name: 'foo-bar', version: '>=1', manifest: 'pyproject.toml' },
      ] },
    ];
    expect(findAmbiguousPackages(pythonNodes)).toEqual(['foo-bar']);
    expect(buildRepoEdges(pythonNodes)).toEqual([]);
  });
});

describe('scanner pure helpers', () => {
  test('inferRepoKind classifies product/library/infra/unknown', () => {
    const reactDeps = [{ name: 'react', version: '^18', manifest: 'package.json' }];
    expect(inferRepoKind([{ manifest: 'package.json', language: 'typescript', dependencies: reactDeps }], reactDeps, [])).toBe('product');
    const honoDeps = [{ name: 'hono', version: '^4', manifest: 'package.json' }];
    expect(inferRepoKind([{ manifest: 'package.json', language: 'typescript', dependencies: honoDeps }], honoDeps, [])).toBe('product');
    expect(inferRepoKind([{ manifest: 'package.json', packageName: '@acme/lib', language: 'typescript', dependencies: [] }], [], [])).toBe('library');
    expect(inferRepoKind([], [], ['main.tf'])).toBe('infra');
    expect(inferRepoKind([], [], ['pom.xml', 'Dockerfile'])).toBe('unknown');
    expect(inferRepoKind([], [], ['README.md'])).toBe('unknown');
  });

  test('buildRepoMapText renders a compact digest', () => {
    const text = buildRepoMapText({
      topDirs: ['src', 'test'],
      entryPoints: ['src/index.ts'],
      commands: { test: 'npm test', build: 'tsc' },
      languages: ['typescript'],
    });
    expect(text).toContain('Languages: typescript');
    expect(text).toContain('Top-level: src, test');
    expect(text).toContain('Entry points: src/index.ts');
    expect(text).toContain('test (`npm test`)');
  });
});

describe('scanner integration (temp fixture)', () => {
  test('scans a suite of sibling repos and derives edges', () => {
    const root = tempDir('octi-repos-');
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
      scripts: { test: 'npm test', build: 'next build' },
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
    expect(app?.repoMap).toContain('test (`npm test`)');

    // Edge: app → core
    const nodes: RepoGraphNode[] = results.map((r) => ({
      id: r.name, name: r.name, packageName: r.packageName, dependencies: r.dependencies,
    }));
    const edges = buildRepoEdges(nodes);
    expect(edges).toEqual([{ from: 'app', to: 'core', via: '@acme/core', version: '^1.0.0' }]);
  });

  test('scanRepoAt returns null for a non-repo directory', () => {
    const root = tempDir('octi-empty-');
    expect(scanRepoAt(root)).toBeNull();
  });

  test('canonicalizes aliases, skips generated repos, and blocks escaping child symlinks', () => {
    const root = tempDir('octi-discovery-');
    const repo = join(root, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'repo' }));
    symlinkSync(repo, join(root, 'repo-alias'), 'dir');

    const generated = join(root, 'node_modules');
    mkdirSync(generated);
    writeFileSync(join(generated, 'package.json'), JSON.stringify({ name: 'generated-copy' }));

    const external = tempDir('octi-external-');
    writeFileSync(join(external, 'package.json'), JSON.stringify({ name: 'external' }));
    symlinkSync(external, join(root, 'external-link'), 'dir');

    expect(findRepoRoots([root, repo, join(root, 'repo-alias')])).toEqual([repo]);
    expect(scanRepoAt(join(root, 'repo-alias'))?.rootPath).toBe(repo);
  });

  test('detects linked-worktree .git files as repository markers', () => {
    const root = tempDir('octi-worktree-');
    const worktree = join(root, 'feature-worktree');
    mkdirSync(worktree);
    writeFileSync(join(worktree, '.git'), 'gitdir: ../source/.git/worktrees/feature-worktree\n');

    expect(isRepoRoot(worktree)).toBe(true);
    expect(scanRepoAt(worktree)?.rootPath).toBe(worktree);
  });

  test('collects every supported manifest language and picks package identity deterministically', () => {
    const root = tempDir('octi-polyglot-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'js-package' }));
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "rust-package"');
    writeFileSync(join(root, 'pubspec.yaml'), 'name: dart_package');
    const scanned = scanRepoAt(root);
    expect(scanned?.languages).toEqual(['javascript', 'rust', 'dart']);
    expect(scanned?.packageName).toBe('js-package');
  });
});


describe('Java repository discovery', () => {
  test('Gradle Groovy identity uses safe local settings and commands fall back to installed build tools', () => {
    const root = tempDir('java-gradle-');
    writeFileSync(join(root, 'settings.gradle'), "rootProject.name = 'service'");
    writeFileSync(join(root, 'build.gradle'), "group = 'com.example'\ndependencies { implementation 'org.springframework.boot:spring-boot-starter-web:3.5.0' }");
    const scanned = scanRepoAt(root)!;
    expect(scanned.packageName).toBe('com.example:service');
    expect(scanned.languages).toEqual(['java']);
    expect(scanned.kind).toBe('product');
    expect(scanned.repoMap).toContain('gradle test');
  });

  test('oversized Maven manifests are not parsed', () => {
    const root = tempDir('java-large-');
    writeFileSync(join(root, 'pom.xml'), '<project>' + ' '.repeat(400_001) + '</project>');
    const scanned = scanRepoAt(root)!;
    expect(scanned.packageName).toBeNull();
    expect(scanned.dependencies).toEqual([]);
  });

  test('Gradle settings symlinks cannot supply an external repository identity', () => {
    const root = tempDir('java-gradle-');
    const outside = tempDir('java-external-');
    writeFileSync(join(outside, 'settings.gradle'), "rootProject.name = 'external-secret'");
    symlinkSync(join(outside, 'settings.gradle'), join(root, 'settings.gradle'));
    writeFileSync(join(root, 'build.gradle'), "group = 'com.example'");
    expect(scanRepoAt(root)?.packageName).not.toContain('external-secret');
  });
});
