#!/usr/bin/env tsx
/**
 * sync-version.ts — set the package version to match a release tag.
 *
 * The release workflow calls this on a `v*` tag so `package.json` and
 * `mcp-server/package.json` (the published npm package) carry the tag's version
 * instead of drifting from the git tag. CHANGELOG curation stays manual.
 *
 * We rewrite ONLY the first `"version": "…"` line in each file with a regex —
 * a JSON parse+stringify round-trip would reformat the whole file and blow up
 * the diff. `setVersion` (pure) is unit-tested.
 *
 *   npx tsx scripts/sync-version.ts 0.2.0
 *   npx tsx scripts/sync-version.ts v0.2.0        # leading v is stripped
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Strip a leading `v` and whitespace. */
export function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, '');
}

/** True for a plausible semver-ish version (`1.2.3`, optional `-rc.1`/`+build`). */
export function isValidVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v);
}

/**
 * Return `pkgJson` with its first top-level `"version"` string replaced.
 * Throws if no version field is present. Preserves all other formatting.
 */
export function setVersion(pkgJson: string, version: string): string {
  const re = /("version"\s*:\s*")[^"]*(")/;
  if (!re.test(pkgJson)) {
    throw new Error('no "version" field found');
  }
  return pkgJson.replace(re, `$1${version}$2`);
}

const TARGETS = ['package.json', join('mcp-server', 'package.json')];

if (import.meta.main) {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: npx tsx scripts/sync-version.ts <version>');
    process.exit(2);
  }
  const version = normalizeVersion(arg);
  if (!isValidVersion(version)) {
    console.error(`Invalid version "${version}" (expected e.g. 1.2.3).`);
    process.exit(2);
  }

  const repoRoot = join(import.meta.dirname, '..');
  for (const rel of TARGETS) {
    const path = join(repoRoot, rel);
    const before = readFileSync(path, 'utf8');
    const after = setVersion(before, version);
    if (after !== before) {
      writeFileSync(path, after);
      console.log(`✓ ${rel} → ${version}`);
    } else {
      console.log(`= ${rel} already at ${version}`);
    }
  }
}
