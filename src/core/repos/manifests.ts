import type { RepoDependency } from '@db/schema/workspace-repos';

/**
 * Manifest parsing for the repo registry. Pure functions — no I/O — so they
 * are trivially unit-testable. Each parser is deliberately lightweight: it
 * extracts the package identity and the declared dependency *names* (the edges
 * out of the repo), not a full manifest model. We avoid pulling in a TOML
 * dependency for what a focused extractor does in a few lines.
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
}

const PACKAGE_JSON = 'package.json';
const CARGO_TOML = 'Cargo.toml';
const GO_MOD = 'go.mod';
const PYPROJECT = 'pyproject.toml';

/** All manifest filenames the scanner looks for, in detection order. */
export const MANIFEST_FILENAMES = [PACKAGE_JSON, CARGO_TOML, GO_MOD, PYPROJECT] as const;

/** Parse a manifest by filename. Returns null when the content is unusable. */
export function parseManifest(filename: string, content: string): ParsedManifest | null {
  switch (filename) {
    case PACKAGE_JSON: return parsePackageJson(content);
    case CARGO_TOML: return parseCargoToml(content);
    case GO_MOD: return parseGoMod(content);
    case PYPROJECT: return parsePyproject(content);
    default: return null;
  }
}

export function parsePackageJson(content: string): ParsedManifest | null {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(content) as Record<string, unknown>;
  } catch {
    // A malformed package.json is not fatal to a scan — skip this manifest.
    return null;
  }
  const deps: RepoDependency[] = [];
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const block = json[field];
    if (block && typeof block === 'object') {
      for (const [name, version] of Object.entries(block as Record<string, unknown>)) {
        deps.push({ name, version: String(version), manifest: PACKAGE_JSON });
      }
    }
  }
  const language = typeof json.types === 'string' || hasTsDep(deps) ? 'typescript' : 'javascript';
  return {
    manifest: PACKAGE_JSON,
    packageName: typeof json.name === 'string' ? json.name : undefined,
    language,
    dependencies: deps,
  };
}

function hasTsDep(deps: RepoDependency[]): boolean {
  return deps.some((d) => d.name === 'typescript');
}

export function parseCargoToml(content: string): ParsedManifest | null {
  const packageName = tomlSectionValue(content, 'package', 'name');
  const deps: RepoDependency[] = [];
  for (const section of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
    for (const [name, version] of tomlSectionEntries(content, section)) {
      deps.push({ name, version, manifest: CARGO_TOML });
    }
  }
  return { manifest: CARGO_TOML, packageName, language: 'rust', dependencies: deps };
}

export function parseGoMod(content: string): ParsedManifest | null {
  let packageName: string | undefined;
  const deps: RepoDependency[] = [];
  let inRequireBlock = false;
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const moduleMatch = line.match(/^module\s+(\S+)/);
    if (moduleMatch) { packageName = moduleMatch[1]; continue; }
    if (line.startsWith('require (')) { inRequireBlock = true; continue; }
    if (inRequireBlock && line === ')') { inRequireBlock = false; continue; }
    // Either inside a require(...) block, or a single-line `require x v`.
    if (inRequireBlock || line.startsWith('require ')) {
      const reqLine = line.startsWith('require ') ? line.slice('require '.length) : line;
      const m = reqLine.match(/^(\S+)\s+(\S+)/);
      if (m) deps.push({ name: m[1], version: m[2], manifest: GO_MOD });
    }
  }
  return { manifest: GO_MOD, packageName, language: 'go', dependencies: deps };
}

export function parsePyproject(content: string): ParsedManifest | null {
  // Supports PEP 621 ([project]) and Poetry ([tool.poetry]) name + deps.
  const packageName = tomlSectionValue(content, 'project', 'name')
    ?? tomlSectionValue(content, 'tool.poetry', 'name');
  const deps: RepoDependency[] = [];
  // PEP 621: dependencies = ["pkg>=1.0", ...]
  for (const spec of tomlArrayValue(content, 'project', 'dependencies')) {
    const { name, version } = splitPep508(spec);
    if (name) deps.push({ name, version, manifest: PYPROJECT });
  }
  // Poetry: [tool.poetry.dependencies] name = "^1.0"
  for (const [name, version] of tomlSectionEntries(content, 'tool.poetry.dependencies')) {
    if (name.toLowerCase() !== 'python') deps.push({ name, version, manifest: PYPROJECT });
  }
  return { manifest: PYPROJECT, packageName, language: 'python', dependencies: deps };
}

// ── Minimal TOML helpers (good enough for name + dependency extraction) ──

/** Lines of the `[section]` table, until the next `[` header. */
function tomlSectionLines(content: string, section: string): string[] {
  const lines = content.split('\n');
  const header = `[${section}]`;
  const out: string[] = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line.startsWith('[')) { inSection = line === header; continue; }
    if (inSection && line) out.push(line);
  }
  return out;
}

/** `key = "value"` lookup inside a `[section]`. */
function tomlSectionValue(content: string, section: string, key: string): string | undefined {
  for (const line of tomlSectionLines(content, section)) {
    const m = line.match(/^(\S+)\s*=\s*(.+)$/);
    if (m && m[1] === key) return stripTomlString(m[2]);
  }
  return undefined;
}

/** All `name = version` entries inside a `[section]` (skips inline tables' detail). */
function tomlSectionEntries(content: string, section: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of tomlSectionLines(content, section)) {
    const m = line.match(/^([A-Za-z0-9_.\-]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const value = m[2].trim();
    // Inline table form: foo = { version = "1.0", ... }
    const inline = value.startsWith('{') ? (value.match(/version\s*=\s*("[^"]*"|'[^']*')/)?.[1] ?? '*') : value;
    out.push([m[1], stripTomlString(inline)]);
  }
  return out;
}

/** `key = ["a", "b"]` array lookup inside a `[section]` (single- or multi-line). */
function tomlArrayValue(content: string, section: string, key: string): string[] {
  const joined = tomlSectionLines(content, section).join('\n');
  // Anchor the key to line start (so `dependencies` does not also match
  // `optional-dependencies`) and escape it (keys may contain `.`/`-`).
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const open = joined.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*=\\s*\\[`));
  if (!open || open.index === undefined) return [];
  // Walk to the matching close bracket by depth — a naive `\]` stops early on
  // the inner brackets of PEP 508 extras like "requests[security]>=2.0".
  const start = open.index + open[0].length;
  let depth = 1;
  let i = start;
  for (; i < joined.length && depth > 0; i++) {
    if (joined[i] === '[') depth++;
    else if (joined[i] === ']') depth--;
  }
  return joined
    .slice(start, i - 1)
    .split(',')
    .map((s) => stripTomlString(s.trim()))
    .filter(Boolean);
}

function stripTomlString(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '').trim();
}

/** Split a PEP 508 requirement ("requests>=2.0; extra") into name + constraint. */
function splitPep508(spec: string): { name: string; version: string } {
  // Drop env markers (after ';') and extras (e.g. "requests[security]>=2.0").
  const cleaned = spec.split(';')[0].trim();
  const m = cleaned.match(/^([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])?\s*(.*)$/);
  if (!m) return { name: '', version: '*' };
  return { name: m[1], version: m[2].trim() || '*' };
}
