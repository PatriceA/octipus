import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The Octipus checkout or install directory: the nearest ancestor of
 * `fromDir` whose package.json is named `octipus`. Works from `src/<…>` under
 * a loader and from the bundled `dist/index.js` alike, where a fixed `../..`
 * from the module lands one level above the install. Throws when there is no
 * such ancestor rather than guessing a parent.
 */
export function octipusRoot(fromDir: string = import.meta.dirname): string {
  let dir = resolve(fromDir);
  while (true) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === 'octipus') return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Cannot locate the Octipus installation above ${fromDir}`);
    dir = parent;
  }
}
