import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { patchCodemodeSource } from './patch-codemode-store.mjs';

test('store compatibility patch changes only the two dictionaries and is idempotent', () => {
  const before = 'const serialized = {};\nconst writes = { set: {}, delete: [] };\nconst unrelated = {};';
  const after = patchCodemodeSource(before);
  expect(after).toBe('const serialized = Object.create(null);\nconst writes = { set: Object.create(null), delete: [] };\nconst unrelated = {};');
  expect(patchCodemodeSource(after)).toBe(after);
});

test('an upstream serialization change requires explicit compatibility review', () => {
  expect(() => patchCodemodeSource('const totallyDifferentImplementation = {};')).toThrow('review scripts/patch-codemode-store.mjs');
});

test('installed sandbox has the serialization patch before an agent runs', () => {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-codemode'));
  const source = readFileSync(join(dirname(entry), 'runtime', 'execution.js'), 'utf8');
  expect(patchCodemodeSource(source)).toBe(source);
});

test('Docker dependency layer includes install lifecycle scripts before npm ci', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
  const layer = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8').split('RUN npm ci')[0];
  for (const command of [pkg.scripts.preinstall, pkg.scripts.postinstall]) {
    for (const path of command?.match(/scripts\/[\w-]+\.mjs/g) ?? []) expect(layer).toContain(`COPY ${path} ${path}`);
  }
});
