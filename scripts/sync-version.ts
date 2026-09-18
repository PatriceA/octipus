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
 *   npx tsx scripts/sync-version.ts v0.3          # normalized to 0.3.0
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Strip a leading `v` and expand a two-component release tag to SemVer. */
export function normalizeVersion(v: string): string {
  const stripped = v.trim().replace(/^v/i, '');
  const short = stripped.match(/^(\d+)\.(\d+)((?:[-+][0-9A-Za-z.-]+)?)$/);
  return short ? `${short[1]}.${short[2]}.0${short[3]}` : stripped;
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

/**
 * The same, for a Cargo manifest: the `version = "…"` of the `[package]` table.
 *
 * Only the first one, and only before the next table header — every dependency
 * below carries a `version` too, and rewriting those would pin the whole tree
 * to the app's release number.
 */
export function setCargoVersion(cargoToml: string, version: string): string {
  const pkg = cargoToml.indexOf('[package]');
  if (pkg === -1) throw new Error('no [package] table found');
  const nextTable = cargoToml.indexOf('\n[', pkg + 1);
  const end = nextTable === -1 ? cargoToml.length : nextTable;
  const head = cargoToml.slice(pkg, end);
  const re = /^(version\s*=\s*")[^"]*(")/m;
  if (!re.test(head)) throw new Error('no version field in [package]');
  return cargoToml.slice(0, pkg) + head.replace(re, `$1${version}$2`) + cargoToml.slice(end);
}

/** Resolve the payload checkout independently from this helper's location. */
export function resolveTargetRoot(override?: string, scriptDir = import.meta.dirname): string {
  return override ? resolve(override) : join(scriptDir, '..');
}

/**
 * Every file in the repo that declares the product version.
 *
 * It was `package.json` and the published npm package, which is why the web
 * app, the plugin SDK and the desktop bundle all still said 0.1.0 four releases
 * in: nothing was wrong with the release, the files were simply never in the
 * list. A version that appears in six places and is maintained in two is a
 * version nobody can trust.
 */
const TARGETS = [
  'package.json',
  join('mcp-server', 'package.json'),
  join('web', 'package.json'),
  join('plugin-sdk', 'package.json'),
  join('web', 'src-tauri', 'tauri.conf.json'),
];

/** Cargo manifests need their own rewrite; see `setCargoVersion`. */
const CARGO_TARGETS = [join('web', 'src-tauri', 'Cargo.toml')];

// Lockfiles carry the version too (`package-lock.json` in three places,
// `Cargo.lock` in one) and are NOT rewritten here: they are generated files,
// and the tools that own them do it correctly —
//   npm install --package-lock-only        (root, mcp-server, web)
//   cargo update -p octipus                (web/src-tauri)
// Run those when bumping the repo; nothing publishes a lockfile version, so a
// release does not need them.

if (import.meta.main) {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: npx tsx scripts/sync-version.ts <version> [target-repo-root]');
    process.exit(2);
  }
  const version = normalizeVersion(arg);
  if (!isValidVersion(version)) {
    console.error(`Invalid version "${version}" (expected e.g. 1.2.3).`);
    process.exit(2);
  }

  const repoRoot = resolveTargetRoot(process.argv[3]);
  const rewrite = (rel: string, fn: (text: string, v: string) => string) => {
    const path = join(repoRoot, rel);
    let before: string;
    try {
      before = readFileSync(path, 'utf8');
    } catch {
      // A target that is not in this checkout is not an error: the release
      // workflow runs against a sparse payload, and a missing optional
      // component must not fail the release of everything else.
      console.log(`- ${rel} not present, skipped`);
      return;
    }
    const after = fn(before, version);
    if (after !== before) {
      writeFileSync(path, after);
      console.log(`✓ ${rel} → ${version}`);
    } else {
      console.log(`= ${rel} already at ${version}`);
    }
  };

  for (const rel of TARGETS) rewrite(rel, setVersion);
  for (const rel of CARGO_TARGETS) rewrite(rel, setCargoVersion);
}
