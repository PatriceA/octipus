/**
 * The offline plugin CLI (`scripts/plugin.ts`) runs under plain `tsx` — CI's
 * "Validate the legacy plugin fixture" job, and `octi plugin …` on a
 * developer's machine — where a `.md` import does not resolve. The role
 * folders import their `prompt.md`, so the CLI must never load them, neither
 * when it starts nor on the commands that handle a package with roles.
 *
 * It did: `contributions/roles.ts` imported the role registry statically,
 * and `octi plugin validate` died with ERR_UNKNOWN_FILE_EXTENSION ".md"
 * before reading its argument. The pure role rules (ids, reserved names, the
 * denied-tool list) live in `src/core/agent/role-rules.ts` for this reason.
 */
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { importChain, staticImportGraph } from '@/test-helpers/import-graph';

const ROOT = resolve(__dirname, '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');

/** A module only the bundler's or the test runner's loader can load. */
const needsMdLoader = (file: string) => file.endsWith('.md') || file.includes('/src/core/agent/roles/') || file.endsWith('/src/core/agent/role-registry.ts');

describe('the offline plugin CLI does not load the role folders', () => {
  test.each(['scripts/plugin.ts', 'scripts/plugin-offline.ts'])('%s reaches no role folder or registry by a static import', (entry) => {
    const graph = staticImportGraph(entry);
    // Guard against a vacuous pass: the walk must actually have followed imports.
    expect(graph.size).toBeGreaterThan(50);
    const offending = [...graph.keys()].filter(needsMdLoader);
    expect(offending.map((f) => importChain(graph, f).join(' -> '))).toEqual([]);
  });

  test.each([
    ['the legacy plugin fixture (the CI job)', 'tests/fixtures/legacy-plugin', 'is a valid legacy plugin'],
    ['a package that declares roles', 'src/plugins/packages/fixtures/role-plugin', 'is a valid plugin package'],
  ])('`octi plugin validate` on %s runs under plain tsx', (_label, dir, expected) => {
    const out = execFileSync(TSX, ['scripts/plugin.ts', 'validate', dir], { cwd: ROOT, encoding: 'utf8', timeout: 90_000 });
    expect(out).toContain(expected);
  }, 120_000);
});
