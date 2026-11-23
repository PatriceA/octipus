/**
 * The STATIC import graph of a TypeScript entry point: what loads when the
 * file is run, before any `await import()` runs. Used to pin that a plain
 * `tsx` entry (a CLI that runs without the bundler's or the test runner's
 * `.md` loader) never reaches modules that only load under one.
 *
 * It reads `import … from '…'`, `export … from '…'` and side-effect
 * `import '…'` statements; `import type` / `export type` are skipped (erased
 * at runtime), and dynamic `import()` is not followed (it loads only when
 * called). Resolves the `@/` alias, relative paths, `.ts` and `index.ts`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const STATIC_IMPORT = /^\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm;

function resolveSpecifier(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(ROOT, 'src', spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null; // a package
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every file the entry loads statically, mapped to the file that first imported it. */
export function staticImportGraph(entry: string): Map<string, string | null> {
  const start = resolve(ROOT, entry);
  const seen = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (!/\.tsx?$/.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(STATIC_IMPORT)) {
      if (match[1]) continue; // `import type` / `export type`
      const target = resolveSpecifier(file, match[2]);
      if (!target || seen.has(target)) continue;
      seen.set(target, file);
      queue.push(target);
    }
  }
  return seen;
}

/** The import chain from the entry to `file`, as repository-relative paths. */
export function importChain(graph: Map<string, string | null>, file: string): string[] {
  const chain: string[] = [];
  for (let at: string | null | undefined = file; at; at = graph.get(at)) chain.unshift(at.slice(ROOT.length + 1));
  return chain;
}
