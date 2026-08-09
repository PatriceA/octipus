/**
 * Custom-JS bundle pipeline for live artifacts. Inputs: a single source
 * string (or several files via virtual entry). Output: a self-contained
 * IIFE bundle written to `data/artifacts/<artifactId>/<versionId>/bundle.js`,
 * plus its sha256 — the embed renderer pins that hash in CSP `script-src`.
 *
 * Build sandboxing: only allow imports from a curated stdlib (none for V1).
 * No fs / child_process / network at build time.
 */

import { copyFile, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { coreLogger } from '@/utils/logger';

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

  const built = await Bun.build({
    entrypoints: [entryPath],
    target: 'browser',
    format: 'iife',
    minify: true,
    sourcemap: 'none',
    naming: '[name].js',
    external: [],
  });
  if (!built.success) {
    const messages = built.logs.map((l) => l.message).join('; ');
    coreLogger.error({ artifactId: input.artifactId, versionId: input.versionId, messages }, 'artifact.bundle.failed');
    throw new Error(`bundler: build failed: ${messages}`);
  }

  let outBytes: Buffer;
  if (built.outputs.length > 0) {
    outBytes = Buffer.from(await built.outputs[0].arrayBuffer());
  } else {
    throw new Error('bundler: no outputs produced');
  }

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
 *
 * ponytail: whole-artifact only. Superseded VERSION directories still
 * accumulate (a few KB each, and old versions must stay readable for rollback);
 * sweep them from `runArtifactCleanup` against `current_version_id` if that
 * ever grows into real disk.
 */
export async function deleteArtifactBundles(artifactId: string): Promise<void> {
  await rm(join(bundlesRoot(), artifactId), { recursive: true, force: true });
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
