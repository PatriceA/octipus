/**
 * Startup budget, structurally (plan §7, Phase 6 item 4): what the two
 * terminal entry points load before their first frame.
 *
 * Time to first frame is measured by hand (docs/guides/tui.md, "Terminal
 * compatibility"); a wall-clock assertion would be flaky on a loaded CI
 * machine. What makes it slow is an eager import of something heavy, and that
 * is a property of the import graph: this test bundles each entry with esbuild
 * (nothing is written or run), walks only the static edges — an `await
 * import()` is where loading is meant to be deferred — and fails if a heavy
 * module is on them.
 */
import { build, type Metafile } from 'esbuild';
import { describe, expect, test } from 'vitest';

const ENTRIES = ['src/tui-pi/index.ts', 'src/tui-editor/index.ts'];

/** Packages that cost tens of milliseconds or more to load and are not needed to draw the first frame. */
const HEAVY_PACKAGES = [
  /^pino(-pretty)?$/, // the server logger; the clients log nothing on a normal start
  /^web-tree-sitter$/, /^tree-sitter-/, // syntax trees: after the first file opens
  /^@anthropic-ai\//, /^openai$/, /^@google\//, // model SDKs
  /^drizzle-orm/, /^@electric-sql\/pglite/, /^postgres$/, // the database
];
/** Source trees the clients only reach on demand (voice, MCP status) or never (server internals). */
const HEAVY_SOURCES = [/^src\/voice\//, /^src\/mcp\//, /^src\/db\//, /^src\/models\//, /^src\/core\/agent\//, /^src\/tools\//];

async function staticGraph(entry: string): Promise<{ files: Set<string>; packages: Map<string, string> }> {
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, metafile: true, platform: 'node', format: 'esm',
    splitting: true, outdir: 'out-never-written', packages: 'external', loader: { '.md': 'text' }, logLevel: 'silent',
    tsconfig: 'tsconfig.json',
  });
  const inputs: Metafile['inputs'] = result.metafile.inputs;
  const files = new Set([entry]);
  const packages = new Map<string, string>();
  const queue = [entry];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const node = inputs[file];
    if (!node) throw new Error(`esbuild's metafile has no entry for ${file}`);
    for (const edge of node.imports) {
      if (edge.kind === 'dynamic-import') continue;
      if (edge.external) {
        if (!edge.path.startsWith('node:') && !packages.has(edge.path)) packages.set(edge.path, file);
      } else if (!files.has(edge.path)) {
        files.add(edge.path);
        queue.push(edge.path);
      }
    }
  }
  return { files, packages };
}

describe('what the terminal clients load before their first frame', () => {
  for (const entry of ENTRIES) {
    test(`${entry} imports nothing heavy eagerly`, async () => {
      const { files, packages } = await staticGraph(entry);
      const heavyPackages = [...packages].filter(([name]) => HEAVY_PACKAGES.some(re => re.test(name))).map(([name, from]) => `${name} (imported by ${from})`);
      const heavySources = [...files].filter(file => HEAVY_SOURCES.some(re => re.test(file)));
      expect(heavyPackages, 'load these with `await import()` where they are used').toEqual([]);
      expect(heavySources, 'load these with `await import()` where they are used').toEqual([]);
      // The walk saw the client itself: an empty graph would pass the checks above vacuously.
      expect(files.size).toBeGreaterThan(20);
      expect(packages.has('@earendil-works/pi-tui')).toBe(true);
    }, 30_000);
  }

  test('the walk does see a deferred import as deferred, and a static one as loaded', async () => {
    // The editor defers tree-sitter; its highlighter module is on the static graph, web-tree-sitter is not.
    const { files, packages } = await staticGraph('src/tui-editor/index.ts');
    expect(files.has('src/tui-editor/editor/highlight-tree-sitter.ts')).toBe(true);
    expect(packages.has('web-tree-sitter')).toBe(false);
    const { packages: direct } = await staticGraph('src/utils/logger.ts');
    expect(direct.has('pino')).toBe(true);
  }, 30_000);
});
