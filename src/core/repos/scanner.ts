import type { RepoDependency, RepoKind } from '@db/schema/workspace-repos';
import { execFileSync } from 'child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { basename, isAbsolute, join, relative, sep } from 'path';
import { coreLogger } from '@/utils/logger';
import { MANIFEST_FILENAMES, type ParsedManifest, parseManifest } from './manifests';

/**
 * Repo scanner — discovers repositories on disk and builds the structured
 * record the registry stores. The pure helpers (`inferRepoKind`,
 * `buildRepoMapText`) are split out so they unit-test without a filesystem.
 *
 * See `.octipus/multi-repo-design.md`.
 */

export interface RepoScanResult {
  name: string;
  rootPath: string;
  remoteUrl: string | null;
  defaultBranch: string | null;
  kind: RepoKind;
  languages: string[];
  packageName: string | null;
  dependencies: RepoDependency[];
  repoMap: string;
  hasAgentsMd: boolean;
}

const APP_FRAMEWORKS = new Set([
  'next', 'react', 'react-dom', 'vue', 'svelte', '@angular/core',
  'express', 'elysia', 'fastify', '@nestjs/core', 'koa', 'hono', 'flutter',
]);

/**
 * Markers that identify a repository root. A superset of the manifests we can
 * parse for dependencies (`MANIFEST_FILENAMES`) — a repo in a language we don't
 * yet parse still belongs in the registry (for its map + AGENTS.md), it just
 * contributes no dependency edges.
 */
const REPO_MARKER_FILES = [
  ...MANIFEST_FILENAMES,
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile',
  'composer.json', 'requirements.txt', 'setup.py',
];

/** Immediate children that are build/dependency outputs, never sibling repos. */
const GENERATED_DIRS = new Set([
  'node_modules', 'vendor', 'target', 'dist', 'build', 'out', 'coverage',
  '__pycache__', 'site-packages', '.gradle',
]);

/** A directory is a repo if it carries a VCS or known project marker. */
export function isRepoRoot(dir: string): boolean {
  if (isFileOrDirectory(join(dir, '.git'))) return true;
  return REPO_MARKER_FILES.some((m) => isFile(join(dir, m)));
}

/**
 * Coarse classification from the parsed manifests + top-level entries.
 * Pure — the inputs are everything it needs.
 */
export function inferRepoKind(
  parsed: ParsedManifest[],
  deps: RepoDependency[],
  topEntries: string[],
): RepoKind {
  const depNames = new Set(deps.map((d) => d.name));
  if ([...APP_FRAMEWORKS].some((f) => depNames.has(f))
    || deps.some(dep => dep.name.startsWith('org.springframework.boot:spring-boot-starter')
      || dep.name.startsWith('io.quarkus:quarkus-')
      || dep.name.startsWith('io.micronaut:micronaut-'))) return 'product';
  const entries = new Set(topEntries);
  const infraMarkers = ['main.tf', 'terraform', 'Chart.yaml', 'helm', 'kustomization.yaml'];
  const hasProjectMarker = parsed.length > 0 || REPO_MARKER_FILES.some((marker) => entries.has(marker));
  if (infraMarkers.some((m) => entries.has(m)) || (!hasProjectMarker && entries.has('Dockerfile'))) {
    return 'infra';
  }
  if (parsed.some((p) => p.packageName)) return 'library';
  return 'unknown';
}

export interface RepoMapInput {
  topDirs: string[];
  entryPoints: string[];
  commands: Record<string, string>;
  languages: string[];
}

/** Compact structural digest — the cheap "mental model" injected on repo entry. Pure. */
export function buildRepoMapText(input: RepoMapInput): string {
  const lines: string[] = [];
  if (input.languages.length) lines.push(`Languages: ${input.languages.join(', ')}`);
  if (input.topDirs.length) lines.push(`Top-level: ${input.topDirs.join(', ')}`);
  if (input.entryPoints.length) lines.push(`Entry points: ${input.entryPoints.join(', ')}`);
  const cmds = Object.entries(input.commands);
  if (cmds.length) lines.push(`Commands: ${cmds.map(([k, v]) => `${k} (\`${v}\`)`).join(', ')}`);
  return lines.join('\n');
}

const ENTRY_CANDIDATES = [
  'src/index.ts', 'src/index.js', 'index.ts', 'index.js',
  'src/main.ts', 'src/main.rs', 'main.go', 'cmd', 'app', 'pages',
  'src/main/java', 'src/test/java',
];

const SCRIPT_KEYS = ['test', 'build', 'lint', 'dev', 'start', 'typecheck'];

/** Scan a single repository root. Returns null when the dir is not a repo. */
export function scanRepoAt(repoRoot: string, name?: string): RepoScanResult | null {
  const canonicalRoot = canonicalDirectory(repoRoot);
  if (!canonicalRoot || !isRepoRoot(canonicalRoot)) return null;

  const topEntries = safeReaddir(canonicalRoot);
  const parsed: ParsedManifest[] = [];
  const gradleOptions = () => ({
    defaultProjectName: basename(canonicalRoot),
    settingsContent: readBuildCompanion(canonicalRoot, 'settings.gradle')
      ?? readBuildCompanion(canonicalRoot, 'settings.gradle.kts'),
    gradleProperties: readBuildCompanion(canonicalRoot, 'gradle.properties'),
  });
  for (const m of MANIFEST_FILENAMES) {
    const p = join(canonicalRoot, m);
    if (!isFile(p)) continue;
    try {
      const content = readBuildCompanion(canonicalRoot, m);
      if (content === undefined) continue;
      const result = parseManifest(m, content, m.startsWith('build.gradle') ? gradleOptions() : undefined);
      if (result) parsed.push(result);
      else coreLogger.warn({ manifest: p }, 'repo scan: ignored malformed manifest');
    } catch (err) {
      // A single unreadable manifest shouldn't abort the whole scan — log and move on.
      coreLogger.warn({ err, manifest: p }, 'repo scan: failed to parse manifest');
    }
  }

  const dependencies = dedupeDependencies(parsed.flatMap((p) => p.dependencies));
  const packageName = parsed.find((p) => p.packageName)?.packageName ?? null;
  const languages = [...new Set(parsed.map((p) => p.language))];

  // package.json scripts → commands surfaced in the repo map.
  const commands = readPackageScripts(canonicalRoot);
  if (parsed.some(manifest => manifest.manifest === 'pom.xml')) {
    const mvn = isFile(join(canonicalRoot, 'mvnw')) ? './mvnw' : 'mvn';
    commands['maven:test'] = `${mvn} test`;
    commands['maven:build'] = `${mvn} package`;
  }
  if (parsed.some(manifest => manifest.manifest.startsWith('build.gradle'))) {
    const gradle = isFile(join(canonicalRoot, 'gradlew')) ? './gradlew' : 'gradle';
    commands['gradle:test'] = `${gradle} test`;
    commands['gradle:build'] = `${gradle} build`;
  }
  const topDirs = topEntries
    .filter((e) => !e.startsWith('.') && !GENERATED_DIRS.has(e) && isDir(join(canonicalRoot, e)))
    .slice(0, 20);
  const entryPoints = ENTRY_CANDIDATES.filter((e) => existsSync(join(canonicalRoot, e)));

  const warnings = [...new Set(parsed.flatMap(manifest => manifest.warnings ?? []))];
  const repoMap = [buildRepoMapText({ topDirs, entryPoints, commands, languages }),
    ...warnings.map(warning => `Dependency analysis: ${warning}`)].join('\n');

  return {
    name: name ?? basename(canonicalRoot),
    rootPath: canonicalRoot,
    remoteUrl: gitRemote(canonicalRoot),
    defaultBranch: gitDefaultBranch(canonicalRoot),
    kind: inferRepoKind(parsed, dependencies, topEntries),
    languages,
    packageName,
    dependencies,
    repoMap,
    hasAgentsMd: isFile(join(canonicalRoot, 'AGENTS.md')),
  };
}

/**
 * Find repository roots under a set of workspace roots: each root itself if it
 * is a repo, plus its immediate non-hidden children that are repos (the common
 * "suite of sibling repos under one workspace" layout).
 */
export function findRepoRoots(roots: string[]): string[] {
  const found = new Set<string>();
  for (const configuredRoot of roots) {
    const root = canonicalDirectory(configuredRoot);
    if (!root) continue;
    if (isRepoRoot(root)) found.add(root);
    for (const child of safeReaddir(root)) {
      if (child.startsWith('.') || GENERATED_DIRS.has(child)) continue;
      const childPath = canonicalDirectory(join(root, child));
      // A linked child outside the configured root must be configured as its
      // own workspace root before discovery may cross that boundary.
      if (!childPath || !isWithin(root, childPath)) continue;
      if (isRepoRoot(childPath)) found.add(childPath);
    }
  }
  return [...found].sort();
}

/** Scan every repo under the given workspace roots. */
export function scanRoots(roots: string[]): RepoScanResult[] {
  const results: RepoScanResult[] = [];
  for (const repoRoot of findRepoRoots(roots)) {
    const result = scanRepoAt(repoRoot);
    if (result) results.push(result);
  }
  return results;
}

// ── small fs/git helpers (best-effort; never throw out of a scan) ──

/** Build settings are read as bounded text, never evaluated or followed through symlinks. */
function readBuildCompanion(root: string, filename: string): string | undefined {
  const path = join(root, filename);
  if (!existsSync(path)) return undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 400_000) {
      coreLogger.warn({ path }, 'repo scan: skipped non-regular or oversized build settings');
      return undefined;
    }
    return readFileSync(path, 'utf-8');
  } catch (err) {
    coreLogger.warn({ err, path }, 'repo scan: failed to read build settings');
    return undefined;
  }
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir).sort(); } catch { return []; }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p: string): boolean {
  try { return lstatSync(p).isFile(); } catch { return false; }
}

function isFileOrDirectory(p: string): boolean {
  try {
    const stat = lstatSync(p);
    return stat.isFile() || stat.isDirectory();
  } catch {
    return false;
  }
}

function canonicalDirectory(p: string): string | null {
  try {
    const canonical = realpathSync(p);
    return statSync(canonical).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function dedupeDependencies(dependencies: RepoDependency[]): RepoDependency[] {
  const seen = new Set<string>();
  return dependencies.filter((dependency) => {
    const key = `${dependency.manifest}\0${dependency.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readPackageScripts(repoRoot: string): Record<string, string> {
  const pkgPath = join(repoRoot, 'package.json');
  if (!isFile(pkgPath)) return {};
  try {
    const json = JSON.parse(readFileSync(pkgPath, 'utf-8')) as unknown;
    if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
    const scripts = 'scripts' in json ? json.scripts : undefined;
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return {};
    const out: Record<string, string> = {};
    for (const key of SCRIPT_KEYS) {
      const value = key in scripts ? (scripts as Record<string, unknown>)[key] : undefined;
      if (typeof value === 'string' && value.trim()) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function gitRemote(repoRoot: string): string | null {
  return git(repoRoot, ['remote', 'get-url', 'origin']);
}

function gitDefaultBranch(repoRoot: string): string | null {
  const remoteHead = git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (remoteHead) return remoteHead.replace(/^origin\//, '');
  return git(repoRoot, ['branch', '--show-current']);
}

function git(repoRoot: string, args: string[]): string | null {
  if (!isFileOrDirectory(join(repoRoot, '.git'))) return null;
  try {
    const out = execFileSync('git', args, {
      cwd: repoRoot,
      timeout: 5_000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}
