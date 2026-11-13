#!/usr/bin/env node
/**
 * botbuilder on zod 4 (postinstall).
 *
 * botbuilder (the Teams channel's SDK) declares zod 3, and zod 3 has no fixed
 * release for GHSA-mrhx-c7xc-m3w5; botbuilder itself has had no release since
 * August 2025. package.json overrides its zod with ours (zod 4), and this
 * script adapts the only two zod 3 calls it makes that zod 4 dropped:
 *
 * - `.nonstrict()` → `.passthrough()` (same meaning: unknown keys are kept);
 * - `err.errors` → `err.issues` (a ZodError's list, only worded into a message).
 *
 * Idempotent; a no-op when botbuilder is not installed. Exits 1 if a zod 3
 * call is still there afterwards (a new botbuilder that needs more), so an
 * install never ends with a Teams channel that fails when it loads.
 * src/channels/teams/botbuilder-zod4.test.ts checks the result in CI.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The packages of the SDK that call zod. */
export const PACKAGES = ['botbuilder', 'botbuilder-core', 'botframework-connector', 'botframework-schema'];

/** zod 3 calls zod 4 no longer has. */
export const ZOD3_ONLY = /\.nonstrict\(\)|JSON\.stringify\(err\.errors\b/;

/** `source` with its zod 3 calls replaced by their zod 4 names. */
export function patchSource(source) {
  return source
    .replace(/\.nonstrict\(\)/g, '.passthrough()')
    .replace(/JSON\.stringify\(err\.errors\b/g, 'JSON.stringify(err.issues');
}

/** The root of each SDK package resolvable from `from`, nested copies included. */
function packageRoots(from) {
  const roots = new Set();
  const visit = (base, name) => {
    let pkg;
    try {
      pkg = createRequire(join(base, 'noop.js')).resolve(`${name}/package.json`);
    } catch {
      return;
    }
    const root = dirname(pkg);
    if (roots.has(root)) return;
    roots.add(root);
    for (const dep of PACKAGES) visit(root, dep);
  };
  for (const name of PACKAGES) visit(from, name);
  return [...roots];
}

/** Every CommonJS file under `lib/` that requires zod (the browser bundles carry their own). */
function zodFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.js') && entry.name !== 'browser.js') {
        const text = readFileSync(path, 'utf8');
        if (text.includes('require("zod")')) out.push({ path, text });
      }
    }
  };
  if (existsSync(join(root, 'lib'))) walk(join(root, 'lib'));
  return out;
}

/** Patch the SDK resolvable from `from`; returns what changed and what still calls zod 3. */
export function patchBotbuilder(from) {
  const patched = [];
  const remaining = [];
  for (const root of packageRoots(from)) {
    for (const { path, text } of zodFiles(root)) {
      const next = patchSource(text);
      if (next !== text) {
        writeFileSync(path, next);
        patched.push(path);
      }
      if (ZOD3_ONLY.test(next)) remaining.push(path);
    }
  }
  return { patched, remaining };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { patched, remaining } = patchBotbuilder(process.cwd());
  if (patched.length) console.log(`botbuilder: adapted ${patched.length} file(s) to zod 4`);
  if (remaining.length) {
    console.error(`botbuilder: zod 3 calls remain in ${remaining.join(', ')}; scripts/patch-botbuilder-zod4.mjs needs updating for this botbuilder version.`);
    process.exitCode = 1;
  }
}
