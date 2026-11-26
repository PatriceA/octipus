import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const vitestRoot = dirname(require.resolve('vitest/package.json'));
const projectRoot = resolve(import.meta.dirname, '../..');

test.each(['pass', 'fail', 'collection-error'])('file scratch is gone before the runner exits (%s)', async mode => {
  const fs = process.getBuiltinModule('node:fs');
  const fixture = fs.mkdtempSync(join(tmpdir(), 'file-lifecycle-'));
  const observed = join(fixture, 'observed.json');
  const hooksDone = join(fixture, 'hooks-done');
  const paused = join(fixture, 'global-teardown');
  const release = join(fixture, 'release');
  const keep = join(fixture, 'project-file');
  writeFileSync(keep, 'keep');
  const setup = join(fixture, 'global.mjs');
  writeFileSync(setup, `
    import setup from ${JSON.stringify(pathToFileURL(join(projectRoot, 'src/test-helpers/tmp-cleanup.ts')).href)};
    import fs from 'node:fs';
    export default function(project) {
      const cleanup = setup(project);
      return async () => {
        fs.writeFileSync(${JSON.stringify(paused)}, 'waiting');
        const start = Date.now();
        while (!fs.existsSync(${JSON.stringify(release)})) {
          if (Date.now() - start > 15000) throw Error('Parent did not release fixture');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        cleanup();
      };
    }
  `);
  writeFileSync(join(fixture, 'fixture.test.mjs'), `
    import { test, afterAll } from ${JSON.stringify(pathToFileURL(join(vitestRoot, 'dist/index.js')).href)};
    import fs from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const scratch = tmpdir();
    const file = join(scratch, 'database-fixture');
    fs.writeFileSync(file, 'fixture');
    fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({scratch}));
    if (${JSON.stringify(mode)} === 'collection-error') throw Error('expected collection failure');
    const descriptor = fs.openSync(file, 'r');
    afterAll(() => {
      if (!fs.existsSync(file)) throw Error('Scratch deleted before fixture teardown');
      fs.closeSync(descriptor);
      fs.writeFileSync(${JSON.stringify(hooksDone)}, 'closed');
    });
    test('fixture', () => {
      if (${JSON.stringify(mode)} === 'fail') throw Error('expected test failure');
    });
  `);
  const config = join(fixture, 'vitest.config.mjs');
  writeFileSync(config, `export default {
    root: ${JSON.stringify(fixture)},
    resolve: { alias: { '@': ${JSON.stringify(join(projectRoot, 'src'))} } },
    test: {
      include: ['fixture.test.mjs'], pool: 'forks', maxWorkers: 1,
      setupFiles: [${JSON.stringify(join(projectRoot, 'src/test-setup.ts'))}],
      globalSetup: [${JSON.stringify(setup)}],
      reporters: ['dot'], watch: false,
    }
  };`);
  const child = spawn(process.execPath, [join(vitestRoot, 'vitest.mjs'), 'run', '--config', config], {
    cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-8000); });
  child.stderr.on('data', chunk => { output = (output + String(chunk)).slice(-8000); });
  const closed = once(child, 'close');
  try {
    await expect.poll(() => {
      if (child.exitCode !== null) throw new Error(`Fixture exited before global teardown: ${output}`);
      return existsSync(paused);
    }, { timeout: 15000 }).toBe(true);
    const { scratch } = JSON.parse(readFileSync(observed, 'utf8')) as { scratch: string };
    expect(child.exitCode).toBeNull();
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(dirname(scratch))).toBe(true);
    expect(existsSync(hooksDone)).toBe(mode !== 'collection-error');
    expect(readFileSync(keep, 'utf8')).toBe('keep');
    writeFileSync(release, 'finish');
    const [code] = await closed;
    expect(code, output).toBe(mode === 'pass' ? 0 : 1);
    expect(existsSync(dirname(scratch))).toBe(false);
    expect(readFileSync(keep, 'utf8')).toBe('keep');
  } finally {
    writeFileSync(release, 'finish');
    if (child.exitCode === null) { child.kill(); await closed; }
  }
});
