import { describe, expect, test } from 'vitest';
import { moduleDataUrl, pathImportProblem } from './in-process-bundle';

describe('in-process bundle', () => {
  test('an import by path is found in every form; built-ins and packages are not', () => {
    for (const src of [
      "import x from './x.mjs';",
      'export { y } from "../y.js";',
      "import './side-effect.js';",
      "const m = await import('./lazy.mjs');",
      "const r = require('./cjs');",
      "import z from '/abs/z.mjs';",
      "import w from 'file:///etc/w.mjs';",
      'const t = await import(`./t-${n}.mjs`);',
    ]) {
      expect(pathImportProblem(`// header\n${src}`), src).toMatch(/imports a module by path \(line 2\)/);
    }
    for (const src of ["import { join } from 'node:path';", "import fs from 'fs';", "const s = 'see ./README';", 'export default function f() {}']) {
      expect(pathImportProblem(src), src).toBeNull();
    }
  });

  test('the bundled module is imported from memory and cannot reach a relative path', async () => {
    const mod = await import(/* @vite-ignore */ moduleDataUrl(Buffer.from("import { join } from 'node:path'; export default () => join('a', 'b');")));
    expect((mod.default as () => string)()).toBe(join('a', 'b'));
    await expect(import(/* @vite-ignore */ moduleDataUrl(Buffer.from("export { x } from './x.mjs';")))).rejects.toThrow();
  });
});

function join(a: string, b: string): string {
  return `${a}/${b}`;
}
