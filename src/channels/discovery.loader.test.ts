/**
 * Channel discovery, run by the REAL Node ESM loader.
 *
 * `discovery.test.ts` next door calls `discoverChannels()` in-process, and it
 * passed on Windows for months while a Windows backend registered no channels
 * at all: `await import('C:\…\index.ts')` throws
 * ERR_UNSUPPORTED_ESM_URL_SCHEME, the loader's own `catch` logged "import
 * failed — skipping" for every folder, and the gateway then reported "Channels
 * initialized (auto-discovered)" over an empty list. Under Vitest the import
 * goes through Vite's module runner, which resolves a bare absolute path
 * happily — so the suite was green in the one configuration the product never
 * runs in.
 *
 * Hence a subprocess: the assertion is worthless unless the import is done by
 * the loader that ships.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

test('every channel folder loads under the real ESM loader', () => {
  const program = [
    "const { discoverChannels } = await import('@/channels/discovery');",
    'const found = await discoverChannels();',
    'process.stdout.write(JSON.stringify(found.map((f) => f.folder).sort()));',
  ].join('\n');

  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--import', './scripts/md-loader.mjs', '--input-type=module', '-e', program],
    { cwd: resolve('.'), encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const folders = JSON.parse(out.slice(out.indexOf('['))) as string[];
  // Not an exact list — channels are a drop folder and the point is that the
  // loader reaches them, not which ones exist today.
  expect(folders).toEqual(expect.arrayContaining(['telegram', 'slack', 'whatsapp']));
}, 180_000);
