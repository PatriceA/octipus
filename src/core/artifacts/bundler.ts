/**
 * Custom-JS bundle pipeline for live artifacts. Inputs: a single source
 * string (or several files via virtual entry). Output: a self-contained
 * IIFE bundle written to `data/artifacts/<artifactId>/<versionId>/bundle.js`,
 * plus its sha256 — the embed renderer pins that hash in CSP `script-src`.
 *
 * Build sandboxing: only allow imports from a curated stdlib (none for V1).
 * No fs / child_process / network at build time.
 */

import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { coreLogger } from '@/utils/logger';
import { build as esbuild } from 'esbuild';

export interface BundleInput {
  artifactId: string;
  versionId: string;
  source: string;
  /** Optional CSS (concat-only, not bundled). */
  css?: string;
}

export interface BundleResult {
  sha256Hex: string;
  bytes: number;
  path: string;
  cssPath?: string;
}

/** Root directory for artifact bundles. Reads from settings; falls back to env then default. */
export function bundlesRoot(): string {
  // Lazy import to keep this module usable in test contexts without booted settings.
  try {
    const { resolveArtifactSettings } = require('./settings') as typeof import('./settings');
    return resolveArtifactSettings().bundlesDir;
  } catch {
    return process.env.ARTIFACT_BUNDLES_DIR ?? join(process.cwd(), 'data', 'artifacts');
  }
}

/** On-disk path of a version's built bundle. */
export function bundleFilePath(artifactId: string, versionId: string): string {
  return join(bundlesRoot(), artifactId, versionId, 'bundle.js');
}

/** Static allow-list of import specifiers permitted in user bundles. V1: empty. */
const ALLOWED_IMPORTS = new Set<string>([]);

// Matches: `import 'x'`, `import x from 'x'`, `import {a} from 'x'`,
// `import('x')`, `require('x')`. Captures the specifier.
const IMPORT_PATTERNS = [
  /\bimport\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
];

export function validateUserBundle(source: string): void {
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const spec = m[1];
      if (!ALLOWED_IMPORTS.has(spec)) {
        throw new Error(`bundler: import not allowed: ${spec}`);
      }
    }
  }
}

/** Build a bundle and persist it. Idempotent — overwrites prior bundle for that version. */
export async function buildAndStoreBundle(input: BundleInput): Promise<BundleResult> {
  validateUserBundle(input.source);

  const outDir = join(bundlesRoot(), input.artifactId, input.versionId);
  await mkdir(outDir, { recursive: true });
  const entryPath = join(outDir, 'entry.js');
  await writeFile(entryPath, input.source, 'utf8');

  const built = await esbuild({
    entryPoints: [entryPath],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    minify: true,
    sourcemap: false,
    write: false,
    logLevel: 'silent',
  }).catch((err: unknown) => {
    const messages = err instanceof Error ? err.message : String(err);
    coreLogger.error({ artifactId: input.artifactId, versionId: input.versionId, messages }, 'artifact.bundle.failed');
    throw new Error(`bundler: build failed: ${messages}`);
  });

  const first = built.outputFiles?.[0];
  if (!first) throw new Error('bundler: no outputs produced');
  const outBytes = Buffer.from(first.contents);

  const bundlePath = bundleFilePath(input.artifactId, input.versionId);
  await writeFile(bundlePath, outBytes);

  const sha256Hex = createHash('sha256').update(outBytes).digest('hex');

  let cssPath: string | undefined;
  if (input.css && input.css.length > 0) {
    cssPath = join(outDir, 'bundle.css');
    await writeFile(cssPath, input.css, 'utf8');
  }

  coreLogger.info(
    { artifactId: input.artifactId, versionId: input.versionId, sha256: sha256Hex, bytes: outBytes.length },
    'artifact.bundle.built',
  );

  return { sha256Hex, bytes: outBytes.length, path: bundlePath, cssPath };
}

/**
 * Drop every bundle an artifact owns. The DB row going away does not take the
 * files with it, so without this a purge leaves them on disk forever with
 * nothing left to reference them.
 */
export async function deleteArtifactBundles(artifactId: string): Promise<void> {
  await rm(join(bundlesRoot(), artifactId), { recursive: true, force: true });
}

/** How many superseded version bundles to keep per artifact. */
export const KEEP_VERSION_BUNDLES = 5;

/**
 * Drop every version bundle except the ones named in `keepVersionIds`.
 *
 * Every edit mints a new versionId and therefore a new directory, and version
 * ROWS are never pruned — so left alone this grows without bound. Which
 * versions to keep is the CALLER's decision, taken from `created_at` in the
 * database: directory mtime looks like the same information but is not, since
 * `copyBundle` stamps a carried-forward bundle with the time it was copied,
 * and version ids are random UUIDs that sort in no useful order.
 */
export async function pruneArtifactBundles(
  artifactId: string,
  keepVersionIds: Iterable<string>,
): Promise<number> {
  const dir = join(bundlesRoot(), artifactId);
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return 0; // no bundles for this artifact
  }

  const keep = new Set(keepVersionIds);
  let removed = 0;
  for (const name of names) {
    if (keep.has(name)) continue;
    await rm(join(dir, name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/**
 * Carry a bundle forward to a new version. Bundles are keyed by versionId, so
 * an edit that touches only the CSS (and reuses the stored template, whose JS
 * was already lifted out) would otherwise land a version with no behaviour.
 * Returns false when there was nothing to copy.
 */
export async function copyBundle(
  artifactId: string,
  fromVersionId: string,
  toVersionId: string,
): Promise<boolean> {
  try {
    const dest = bundleFilePath(artifactId, toVersionId);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(bundleFilePath(artifactId, fromVersionId), dest);
    return true;
  } catch {
    return false;
  }
}

export async function readBundleSha(artifactId: string, versionId: string): Promise<string | null> {
  try {
    const buf = await readFile(bundleFilePath(artifactId, versionId));
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}
