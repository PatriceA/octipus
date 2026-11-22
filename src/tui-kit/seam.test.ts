import { globSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

/**
 * pi-tui is imported in one place, src/tui-kit/, so that moving to the
 * maintained package or replacing the screen layer touches one directory
 * (docs/plans/tui-modernization.md §4.3). Module augmentation goes through
 * the seam too: `declare module '@/tui-kit'`.
 */
test('nothing outside src/tui-kit imports pi-tui', () => {
  const files = ['src', 'tests', 'scripts', 'bin', 'plugins', 'mcp-server/src']
    .flatMap(dir => globSync(`${dir}/**/*.{ts,tsx,mts,cts,js,mjs,cjs}`, { exclude: name => name === 'node_modules' || name === 'dist' }))
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => !file.startsWith('src/tui-kit/'));
  expect(files.length).toBeGreaterThan(100);
  const offenders = files.filter(file => /['"`]@mariozechner\/pi-tui(?:\/[^'"`]*)?['"`]/.test(readFileSync(file, 'utf8')));
  expect(offenders).toEqual([]);
});
