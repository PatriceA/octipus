/**
 * The published artifact, not the source.
 *
 * The role registry used to scan its own directory at runtime. That worked from
 * source and produced an EMPTY registry inside the bundle — `import.meta.url`
 * resolves into `dist/`, where there are no role folders — so the root agent
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
import { discoverTools } from '@/tools/discovery';
import { ROLE_CONFIGS } from '@/core/agent/roles';

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

  test('carries every built-in tool', async () => {
    // Same failure as the prompts, and quieter: the tool registry scanned its
    // own directory too, so the bundle came up with no filesystem, no shell and
    // no search, and only a debug line said anything.
    const tools = await discoverTools();
    expect(tools.length).toBeGreaterThan(20);
    for (const { tool } of tools) {
      // Either quoting style — esbuild picks per string, so pinning one would
      // make the assertion about the minifier rather than about the tool.
      const present = bundle.includes(`'${tool.id}'`) || bundle.includes(`"${tool.id}"`);
      expect(present, `tool ${tool.id} is missing from the bundle`).toBe(true);
    }
  });

  test('resolves neither roles nor tools by reading a directory', () => {
    // Both failures were a directory scan resolving into `dist/`. If either
    // comes back, this catches it before a user does.
    expect(bundle).not.toMatch(/readdirSync\([^)]*roles/);
    expect(bundle).not.toMatch(/readdirSync\(HERE\)/);
  });
});

/**
 * Every entry point that boots product code needs the markdown loader hook,
 * because the role prompts are imported rather than read. Without it the
 * script does not start at all — `npm run dev` was broken exactly this way —
 * so the cost of forgetting is total and the check belongs here rather than in
 * a reviewer's head.
 */
describe('the tsx entry points', () => {
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };

  test('every script that runs tsx registers the markdown loader', () => {
    const missing = Object.entries(pkg.scripts)
      .filter(([, cmd]) => /(^|\s)tsx(\s|$)/.test(cmd))
      .filter(([, cmd]) => !cmd.includes('--import ./scripts/md-loader.mjs'))
      .map(([name]) => name);
    expect(missing, `scripts missing the loader: ${missing.join(', ')}`).toEqual([]);
  });
});
