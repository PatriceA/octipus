import { execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, join } from 'path';
import type { RepoDependency, RepoKind } from '@db/schema/workspace-repos';
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
  'express', 'elysia', 'fastify', '@nestjs/core', 'koa',
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
  'pubspec.yaml', 'composer.json', 'requirements.txt', 'setup.py',
];

/** A directory is a repo if it carries a VCS or known project marker. */
export function isRepoRoot(dir: string): boolean {
  if (existsSync(join(dir, '.git'))) return true;
  return REPO_MARKER_FILES.some((m) => existsSync(join(dir, m)));
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
  if ([...APP_FRAMEWORKS].some((f) => depNames.has(f))) return 'product';
  const entries = new Set(topEntries);
  const infraMarkers = ['main.tf', 'terraform', 'Chart.yaml', 'helm', 'kustomization.yaml'];
  const hasCodeManifest = parsed.length > 0;
  if (infraMarkers.some((m) => entries.has(m)) || (!hasCodeManifest && entries.has('Dockerfile'))) {
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
];

const SCRIPT_KEYS = ['test', 'build', 'lint', 'dev', 'start', 'typecheck'];

/** Scan a single repository root. Returns null when the dir is not a repo. */
export function scanRepoAt(repoRoot: string, name?: string): RepoScanResult | null {
  if (!isRepoRoot(repoRoot)) return null;

  const topEntries = safeReaddir(repoRoot);
  const parsed: ParsedManifest[] = [];
  for (const m of MANIFEST_FILENAMES) {
    const p = join(repoRoot, m);
    if (!existsSync(p)) continue;
    try {
      const result = parseManifest(m, readFileSync(p, 'utf-8'));
      if (result) parsed.push(result);
    } catch (err) {
      // A single unreadable manifest shouldn't abort the whole scan — log and move on.
      coreLogger.warn({ err, manifest: p }, 'repo scan: failed to parse manifest');
    }
  }

  const dependencies = parsed.flatMap((p) => p.dependencies);
  const packageName = parsed.find((p) => p.packageName)?.packageName ?? null;
  const languages = [...new Set(parsed.map((p) => p.language))];

  // package.json scripts → commands surfaced in the repo map.
  const commands = readPackageScripts(repoRoot);
  const topDirs = topEntries
    .filter((e) => !e.startsWith('.') && isDir(join(repoRoot, e)))
    .slice(0, 20);
  const entryPoints = ENTRY_CANDIDATES.filter((e) => existsSync(join(repoRoot, e)));

  const repoMap = buildRepoMapText({ topDirs, entryPoints, commands, languages });

  return {
    name: name ?? basename(repoRoot),
    rootPath: repoRoot,
    remoteUrl: gitRemote(repoRoot),
    defaultBranch: gitDefaultBranch(repoRoot),
    kind: inferRepoKind(parsed, dependencies, topEntries),
    languages,
    packageName,
    dependencies,
    repoMap,
    hasAgentsMd: existsSync(join(repoRoot, 'AGENTS.md')),
  };
}

/**
 * Find repository roots under a set of workspace roots: each root itself if it
 * is a repo, plus its immediate non-hidden children that are repos (the common
 * "suite of sibling repos under one workspace" layout).
 */
export function findRepoRoots(roots: string[]): string[] {
  const found = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root) || !isDir(root)) continue;
    if (isRepoRoot(root)) found.add(root);
    for (const child of safeReaddir(root)) {
      if (child.startsWith('.')) continue;
      const childPath = join(root, child);
      if (isDir(childPath) && isRepoRoot(childPath)) found.add(childPath);
    }
  }
  return [...found];
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

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function readPackageScripts(repoRoot: string): Record<string, string> {
  const pkgPath = join(repoRoot, 'package.json');
  if (!existsSync(pkgPath)) return {};
  try {
    const json = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
    const out: Record<string, string> = {};
    for (const key of SCRIPT_KEYS) {
      if (json.scripts?.[key]) out[key] = json.scripts[key];
    }
    return out;
  } catch {
    return {};
  }
}

function gitRemote(repoRoot: string): string | null {
  return git(repoRoot, 'git remote get-url origin');
}

function gitDefaultBranch(repoRoot: string): string | null {
  return git(repoRoot, 'git rev-parse --abbrev-ref HEAD');
}

function git(repoRoot: string, cmd: string): string | null {
  if (!existsSync(join(repoRoot, '.git'))) return null;
  try {
    const out = execSync(`${cmd} 2>/dev/null`, { cwd: repoRoot, timeout: 5_000, encoding: 'utf-8' }).trim();
    return out || null;
  } catch {
    return null;
  }
}
