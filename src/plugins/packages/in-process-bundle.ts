/**
 * An in-process plugin is ONE bundled module (docs/PLUGIN-PACKAGES.md#runtimes):
 * the package holds exactly one code file, its `entry`, and that file
 * imports nothing by path, only Node built-ins (`node:fs`, ...). Bundle the
 * plugin and its dependencies into it, e.g. `esbuild src/index.ts --bundle
 * --platform=node --format=esm --outfile=dist/plugin.mjs`.
 *
 * Why: what runs must be exactly the bytes that were approved. A module
 * imported by path is cached by the process under that path, so after an
 * upgrade an old imported module would keep running; and a file read again
 * after its check could have changed in between. So the loader
 * (`readVerifiedEntry`) hashes the package, reads the entry's bytes into
 * memory once, checks them against the line for the entry in the very
 * listing that matched the approved hash, and imports those bytes from a
 * `data:` URL: nothing is read from disk after the check, and a `data:`
 * module cannot import a relative path at all.
 *
 * Install refuses a package that breaks the rule (`checkInProcessBundle`),
 * so the author hears it at once rather than at load.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONTENT_HASH_PREFIX, CONTENT_MISMATCH_PROBLEM, contentListing } from './integrity';

/** Files that are code a module loader could run: JavaScript and TypeScript in every flavour, native addons, WebAssembly. */
const CODE_FILE_RE = /\.(?:[cm]?[jt]sx?|node|wasm)$/i;

/**
 * A static import, re-export, dynamic import or require of a path (relative,
 * absolute or `file:`) rather than a package or built-in. A computed
 * specifier cannot be seen statically; from a `data:` module a relative one
 * fails anyway.
 */
const PATH_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"`])(?:\.{1,2}\/|\/|file:)/;

/** The code files of a package directory other than `entry`, as package-relative paths. */
async function otherCodeFiles(dir: string, entry: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const d of await readdir(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) await walk(join(abs, d.name), childRel);
      else if (CODE_FILE_RE.test(d.name) && childRel !== entry) found.push(childRel);
    }
  };
  await walk(dir, '');
  return found.sort();
}

/** Why `source` (the entry) breaks the one-module rule, or null. */
export function pathImportProblem(source: string): string | null {
  const m = PATH_IMPORT_RE.exec(source);
  if (!m) return null;
  const line = source.slice(0, m.index).split('\n').length;
  return `it imports a module by path (line ${line}); bundle the plugin into one file (e.g. esbuild --bundle) and import only Node built-ins`;
}

/**
 * The problems that keep a package directory from being an in-process
 * plugin: other code files beside the entry, or an entry that imports by
 * path. Empty when it is one bundled module.
 */
export async function checkInProcessBundle(dir: string, entry: string): Promise<string[]> {
  const problems: string[] = [];
  const others = await otherCodeFiles(dir, entry);
  if (others.length > 0) {
    const shown = others.slice(0, 5).join(', ') + (others.length > 5 ? ` and ${others.length - 5} more` : '');
    problems.push(`an in-process plugin is one bundled module: the package may hold no code file but its entry ${entry} (found ${shown}); bundle it into one file (e.g. esbuild --bundle)`);
  }
  const importProblem = pathImportProblem(await readFile(join(dir, entry), 'utf8'));
  if (importProblem) problems.push(`entry: ${entry} ${importProblem}`);
  return problems;
}

/** The problem shown when the entry changed between the package check and reading it. */
export const ENTRY_CHANGED_PROBLEM = 'The entry module changed while it was being loaded; not loaded (approve its content again if the change is meant)';

/**
 * The entry's bytes, exactly as approved: the package is listed and hashed,
 * the listing must hash to `pkg.contentHash`, hold no other code file, and
 * the bytes read afterwards must match its line for the entry. Either the
 * bytes, or the reason they may not run.
 */
export async function readVerifiedEntry(
  dir: string,
  pkg: { name: string; version: string; contentHash: string },
  entry: string,
): Promise<{ bytes: Buffer } | { problem: string }> {
  const listing = await contentListing(dir, pkg);
  const listed = `${CONTENT_HASH_PREFIX}${createHash('sha256').update(listing).digest('hex')}`;
  if (listed !== pkg.contentHash) return { problem: CONTENT_MISMATCH_PROBLEM };
  const lines = listing.split('\n');
  const others = lines
    .map((l) => /^(?:file|link|special) [0-9a-f]* ?(".*")$/.exec(l)?.[1])
    .filter((q): q is string => q !== undefined)
    .map((q) => JSON.parse(q) as string)
    .filter((p) => CODE_FILE_RE.test(p.split('/').pop() ?? '') && p !== entry);
  if (others.length > 0) return { problem: `Holds code files beside its entry (${others.slice(0, 5).join(', ')}); an in-process plugin is one bundled module` };
  const line = lines.find((l) => l.endsWith(` ${JSON.stringify(entry)}`));
  const expected = line ? /^file ([0-9a-f]{64}) /.exec(line)?.[1] : undefined;
  if (!expected) return { problem: `entry: ${entry} is not a file in the approved content` };
  const bytes = await readFile(join(dir, entry));
  if (createHash('sha256').update(bytes).digest('hex') !== expected) return { problem: ENTRY_CHANGED_PROBLEM };
  const importProblem = pathImportProblem(bytes.toString('utf8'));
  if (importProblem) return { problem: `${entry}: ${importProblem}` };
  return { bytes };
}

/** A `data:` URL of a module's bytes: imported from memory, it is exactly these bytes and resolves no relative path. */
export function moduleDataUrl(bytes: Buffer): string {
  return `data:text/javascript;base64,${bytes.toString('base64')}`;
}
