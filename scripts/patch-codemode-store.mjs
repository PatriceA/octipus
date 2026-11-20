#!/usr/bin/env node
/** Correct the sandbox library's two object dictionaries at install, as with
 * the existing botbuilder compatibility patch. Ordinary objects lose a
 * __proto__ key through its setter in both snapshot and write serialization.
 * No VM globals or user source are changed. Fail if a library upgrade changes
 * these sites, so the compatibility fix must be reviewed rather than skipped. */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** @param {string} source */
export function patchCodemodeSource(source) {
  const sites = [
    ['const serialized = {};', 'const serialized = Object.create(null);'],
    ['const writes = { set: {}, delete: [] };', 'const writes = { set: Object.create(null), delete: [] };'],
  ];
  let result = source;
  for (const [before, after] of sites) {
    if (result.includes(after)) continue;
    if (result.split(before).length !== 2) throw new Error('Codemode store serialization changed; review scripts/patch-codemode-store.mjs for the installed version.');
    result = result.replace(before, after);
  }
  return result;
}

export function patchCodemodeStore() {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-codemode'));
  const file = join(dirname(entry), 'runtime', 'execution.js');
  const source = readFileSync(file, 'utf8');
  const next = patchCodemodeSource(source);
  if (source !== next) writeFileSync(file, next);
  return source !== next;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { if (patchCodemodeStore()) console.log('codemode: corrected prototype-like store key serialization'); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
