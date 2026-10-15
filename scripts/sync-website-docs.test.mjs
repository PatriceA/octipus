import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'scripts/sync-website-docs.mjs');

function runSync(target, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, target, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'octipus-website-sync-'));
  await writeFile(path.join(dir, 'astro.config.mjs'), 'export default {}\n');
  return dir;
}

test('sync renders mapped links, preserves fenced code, and removes old MDX output', async () => {
  const target = await fixture();
  try {
    const old = path.join(target, 'src/content/docs/docs/getting-started/configuration.mdx');
    await mkdir(path.dirname(old), { recursive: true });
    await writeFile(old, 'stale\n');
    const result = await runSync(target);
    assert.equal(result.code, 0, result.stderr);

    const source = await readFile(path.join(root, 'docs/CONFIGURATION.md'), 'utf8');
    const output = await readFile(path.join(target, 'src/content/docs/docs/getting-started/configuration.md'), 'utf8');
    assert.match(output, /\[Configuration precedence\]\(\/docs\/getting-started\/configuration-precedence\/\)/);
    assert.match(output, /https:\/\/github\.com\/PatriceA\/octipus\/blob\/main\/docs\/plans\/federation-spec\.md/);
    assert.ok(!output.includes('stale'));
    assert.equal(await readFile(old, 'utf8').catch((error) => error.code), 'ENOENT');

    const fenced = (text) => [...text.matchAll(/^(```.*\n[\s\S]*?^```)/gm)].map((match) => match[1]);
    assert.deepEqual(fenced(output), fenced(source));
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('--check reports drift without mutating the generated page', async () => {
  const target = await fixture();
  try {
    assert.equal((await runSync(target)).code, 0);
    const outputPath = path.join(target, 'src/content/docs/docs/getting-started/installation.md');
    const before = await readFile(outputPath, 'utf8');
    await writeFile(outputPath, `${before}\nlocal edit\n`);

    const result = await runSync(target, '--check');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Out of sync: docs\/INSTALLATION\.md/);
    assert.equal(await readFile(outputPath, 'utf8'), `${before}\nlocal edit\n`);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
