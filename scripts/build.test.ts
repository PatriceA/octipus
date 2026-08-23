/**
 * The published artifact, not the source.
 *
 * The role registry used to scan its own directory at runtime. That worked from
 * source and produced an EMPTY registry inside the bundle — `import.meta.url`
 * resolves into `dist/`, where there are no role folders — so the orchestrator
 * failed its first turn with "Cannot read properties of undefined (reading
 * 'systemPromptTemplate')" and nothing in the suite noticed, because every
 * suite ran against source.
 *
 * These assertions run against `dist/index.js` and fail if the prompts stop
 * travelling with it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ROLE_CONFIGS } from '@/core/orchestrator/roles';

const BUNDLE = join(import.meta.dirname, '..', 'dist', 'index.js');
const built = existsSync(BUNDLE);

describe.skipIf(!built)('the built artifact', () => {
  const bundle = built ? readFileSync(BUNDLE, 'utf8') : '';

  test('carries every role prompt inline', () => {
    const roles = Object.keys(ROLE_CONFIGS);
    expect(roles.length).toBeGreaterThan(10);
    for (const role of roles) {
      const prompt = ROLE_CONFIGS[role as keyof typeof ROLE_CONFIGS].systemPromptTemplate;
      // The longest ASCII-only run with nothing the bundler escapes — no
      // newline, quote, backslash or non-ASCII character (esbuild emits those
      // as `\uXXXX`). What is left is byte-identical in the output whichever
      // quoting style it picks.
      const probe = prompt
        .split(/[\n"'`$\\]|[^\x20-\x7e]/)
        .map((l) => l.trim())
        .filter((l) => l.length > 30)
        .sort((a, b) => b.length - a.length)[0];
      expect(probe, `role ${role} has no usable prompt line`).toBeTruthy();
      expect(bundle, `role ${role} prompt is missing from the bundle`).toContain(probe);
    }
  });

  test('does not read the role directory at runtime', () => {
    // The failure mode was a directory scan resolving into `dist/`. If one
    // comes back, this catches it before a user does.
    expect(bundle).not.toMatch(/readdirSync\([^)]*roles/);
  });
});
