import { parseMavenPom, parseGradleBuild, type GradleManifestOptions } from './java-manifests';
import type { RepoDependency } from '@db/schema/workspace-repos';
import { load as parseYaml } from 'js-yaml';
import { parse as parseToml, type TomlTable, type TomlValue } from 'smol-toml';

/**
 * Manifest parsing for the repo registry. Pure functions — no I/O — so they
 * are trivially unit-testable. Each parser extracts only package identities
 * and declared dependency names, while a real TOML parser handles quoting,
 * comments, arrays, and malformed input.
 */

export interface ParsedManifest {
  /** Manifest filename this came from. */
  manifest: string;
  /** Canonical package name the repo publishes, if declared. */
  packageName?: string;
  /** Primary language implied by the manifest. */
  language: string;
  /** Declared dependencies (names + version constraints). */
  dependencies: RepoDependency[];
  /** Static analysis limits that must remain visible in the repository map. */
  warnings?: string[];
}

const PACKAGE_JSON = 'package.json';
const CARGO_TOML = 'Cargo.toml';
const GO_MOD = 'go.mod';
const PYPROJECT = 'pyproject.toml';
const PUBSPEC = 'pubspec.yaml';

/** All manifest filenames the scanner looks for, in detection order. */
export const MANIFEST_FILENAMES = [PACKAGE_JSON, CARGO_TOML, GO_MOD, PYPROJECT, PUBSPEC, 'pom.xml', 'build.gradle', 'build.gradle.kts'] as const;

/** Parse a manifest by filename. Returns null when the content is unusable. */
export function parseManifest(filename: string, content: string, options?: GradleManifestOptions): ParsedManifest | null {
  switch (filename) {
    case PACKAGE_JSON: return parsePackageJson(content);
    case CARGO_TOML: return parseCargoToml(content);
    case GO_MOD: return parseGoMod(content);
    case PYPROJECT: return parsePyproject(content);
    case PUBSPEC: return parsePubspec(content);
    case 'pom.xml': return parseMavenPom(content);
    case 'build.gradle':
    case 'build.gradle.kts': return parseGradleBuild(filename, content, options);
    default: return null;
  }
}

export function parsePackageJson(content: string): ParsedManifest | null {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;

  const deps: RepoDependency[] = [];
  const seen = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const block = json[field];
    if (!isRecord(block)) continue;
    for (const [declaredName, rawVersion] of Object.entries(block)) {
      if (typeof rawVersion !== 'string') continue;
      const dependency = npmDependency(declaredName, rawVersion);
      addDependency(deps, seen, dependency.name, dependency.version, PACKAGE_JSON);
    }
  }

  const packageName = nonEmptyString(json.name);
  const language = nonEmptyString(json.types) || nonEmptyString(json.typings) || hasTsDep(deps)
    ? 'typescript'
    : 'javascript';
  return { manifest: PACKAGE_JSON, packageName, language, dependencies: deps };
}

/** Resolve npm aliases such as `compat: "npm:@acme/core@^2"`. */
function npmDependency(declaredName: string, version: string): { name: string; version: string } {
  if (!version.startsWith('npm:')) return { name: declaredName, version };
  const target = version.slice('npm:'.length).trim();
  const separator = target.lastIndexOf('@');
  const scopedNameEnd = target.startsWith('@') ? target.indexOf('/') : -1;
  if (separator > scopedNameEnd) {
    return {
      name: target.slice(0, separator),
      version: target.slice(separator + 1) || '*',
    };
  }
  return { name: target || declaredName, version: '*' };
}

function hasTsDep(deps: RepoDependency[]): boolean {
  return deps.some((d) => d.name === 'typescript');
}

export function parseCargoToml(content: string): ParsedManifest | null {
  const toml = parseTomlDocument(content);
  if (!toml) return null;
  const packageTable = tableAt(toml, 'package');
  const workspaceTable = tableAt(toml, 'workspace');
  const dependencyTables = [
    tableAt(toml, 'dependencies'),
    tableAt(toml, 'dev-dependencies'),
    tableAt(toml, 'build-dependencies'),
  ];

  const targetTable = tableAt(toml, 'target');
  if (targetTable) {
    for (const target of Object.values(targetTable)) {
      if (!isTomlTable(target)) continue;
      dependencyTables.push(
        tableAt(target, 'dependencies'),
        tableAt(target, 'dev-dependencies'),
        tableAt(target, 'build-dependencies'),
      );
    }
  }
  if (!packageTable && !workspaceTable && dependencyTables.every((table) => !table)) return null;

  const deps: RepoDependency[] = [];
  const seen = new Set<string>();
  for (const table of dependencyTables) {
    if (!table) continue;
    for (const [declaredName, declaration] of Object.entries(table)) {
      if (typeof declaration === 'string') {
        addDependency(deps, seen, declaredName, declaration, CARGO_TOML);
      } else if (isTomlTable(declaration)) {
        const packageName = nonEmptyString(declaration.package) ?? declaredName;
        const version = nonEmptyString(declaration.version) ?? '*';
        addDependency(deps, seen, packageName, version, CARGO_TOML);
      }
    }
  }

  return {
    manifest: CARGO_TOML,
    packageName: packageTable ? nonEmptyString(packageTable.name) : undefined,
    language: 'rust',
    dependencies: deps,
  };
}

export function parseGoMod(content: string): ParsedManifest | null {
  let packageName: string | undefined;
  const deps: RepoDependency[] = [];
  const seen = new Set<string>();
  let inRequireBlock = false;
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const moduleMatch = line.match(/^module\s+("[^"]+"|`[^`]+`|\S+)/);
    if (moduleMatch) {
      packageName = unquoteGoToken(moduleMatch[1]);
      continue;
    }
    if (/^require\s*\($/.test(line)) {
      if (inRequireBlock) return null;
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && line === ')') {
      inRequireBlock = false;
      continue;
    }
    if (inRequireBlock || line.startsWith('require ')) {
      const reqLine = line.startsWith('require ') ? line.slice('require '.length).trim() : line;
      const match = reqLine.match(/^("[^"]+"|`[^`]+`|\S+)\s+(\S+)/);
      if (match) addDependency(deps, seen, unquoteGoToken(match[1]), match[2], GO_MOD);
    }
  }
  if (!packageName || inRequireBlock) return null;
  return { manifest: GO_MOD, packageName, language: 'go', dependencies: deps };
}

export function parsePyproject(content: string): ParsedManifest | null {
  const toml = parseTomlDocument(content);
  if (!toml || Object.keys(toml).length === 0) return null;

  const project = tableAt(toml, 'project');
  const poetry = tableAt(toml, 'tool', 'poetry');
  const packageName = nonEmptyString(project?.name) ?? nonEmptyString(poetry?.name);
  const deps: RepoDependency[] = [];
  const seen = new Set<string>();

  addPep508Array(deps, seen, project?.dependencies);
  const optionalDependencies = project ? tableAt(project, 'optional-dependencies') : undefined;
  if (optionalDependencies) {
    for (const group of Object.values(optionalDependencies)) addPep508Array(deps, seen, group);
  }

  addPoetryTable(deps, seen, poetry ? tableAt(poetry, 'dependencies') : undefined);
  const poetryGroups = poetry ? tableAt(poetry, 'group') : undefined;
  if (poetryGroups) {
    for (const group of Object.values(poetryGroups)) {
      if (isTomlTable(group)) addPoetryTable(deps, seen, tableAt(group, 'dependencies'));
    }
  }

  return { manifest: PYPROJECT, packageName, language: 'python', dependencies: deps };
}

export function parsePubspec(content: string): ParsedManifest | null {
  let yaml: unknown;
  try {
    yaml = parseYaml(content);
  } catch {
    return null;
  }
  if (!isRecord(yaml)) return null;

  const deps: RepoDependency[] = [];
  const seen = new Set<string>();
  for (const field of ['dependencies', 'dev_dependencies']) {
    const table = yaml[field];
    if (!isRecord(table)) continue;
    for (const [name, declaration] of Object.entries(table)) {
      if (typeof declaration === 'string' || typeof declaration === 'number') {
        addDependency(deps, seen, name, String(declaration), PUBSPEC);
      } else if (isRecord(declaration)) {
        addDependency(deps, seen, name, pubspecConstraint(declaration), PUBSPEC);
      }
    }
  }

  return {
    manifest: PUBSPEC,
    packageName: nonEmptyString(yaml.name),
    language: 'dart',
    dependencies: deps,
  };
}

function pubspecConstraint(declaration: Record<string, unknown>): string {
  const version = nonEmptyString(declaration.version);
  if (version) return version;
  const path = nonEmptyString(declaration.path);
  if (path) return `path:${path}`;
  const sdk = nonEmptyString(declaration.sdk);
  if (sdk) return `sdk:${sdk}`;
  const git = nonEmptyString(declaration.git);
  if (git) return `git:${git}`;
  return '*';
}

function addPep508Array(deps: RepoDependency[], seen: Set<string>, value: TomlValue | undefined): void {
  if (!Array.isArray(value)) return;
  for (const spec of value) {
    if (typeof spec !== 'string') continue;
    const { name, version } = splitPep508(spec);
    addDependency(deps, seen, name, version, PYPROJECT);
  }
}

function addPoetryTable(deps: RepoDependency[], seen: Set<string>, table: TomlTable | undefined): void {
  if (!table) return;
  for (const [name, declaration] of Object.entries(table)) {
    if (name.toLowerCase() === 'python') continue;
    if (typeof declaration === 'string') {
      addDependency(deps, seen, name, declaration, PYPROJECT);
    } else if (isTomlTable(declaration)) {
      addDependency(deps, seen, name, nonEmptyString(declaration.version) ?? '*', PYPROJECT);
    }
  }
}

function parseTomlDocument(content: string): TomlTable | null {
  try {
    return parseToml(content);
  } catch {
    return null;
  }
}

function tableAt(root: TomlTable, ...path: string[]): TomlTable | undefined {
  let current: TomlValue = root;
  for (const segment of path) {
    if (!isTomlTable(current)) return undefined;
    current = current[segment];
  }
  return isTomlTable(current) ? current : undefined;
}

function isTomlTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function addDependency(
  deps: RepoDependency[],
  seen: Set<string>,
  name: string,
  version: string,
  manifest: string,
): void {
  const cleanName = name.trim();
  if (!cleanName || seen.has(cleanName)) return;
  seen.add(cleanName);
  deps.push({ name: cleanName, version: version.trim() || '*', manifest });
}

function unquoteGoToken(value: string): string {
  return value.replace(/^(?:"|`)|(?:"|`)$/g, '');
}

/** Split a PEP 508 requirement ("requests>=2.0; extra") into name + constraint. */
function splitPep508(spec: string): { name: string; version: string } {
  const cleaned = spec.split(';')[0].trim();
  const match = cleaned.match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(.*)$/);
  if (!match) return { name: '', version: '*' };
  return { name: match[1], version: match[2].trim() || '*' };
}
