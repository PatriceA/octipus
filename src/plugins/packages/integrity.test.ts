/**
 * Content pinning of plugin packages (docs/PLUGIN-PACKAGES.md#content-pinning):
 * the hash is stable whatever order files were written in, changes with any
 * byte, path, name or version, and a check against it refuses changed files
 * and records a hash on first use.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { contentListing, hashPackageContent, isContentHash, verifyPackageContent } from './integrity';

const ID = { name: 'demo', version: '1.0.0' };
const dirs: string[] = [];

/** A package directory with `files` written in the order given. */
function pkg(files: Array<[string, string]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'octipus-integrity-'));
  dirs.push(dir);
  for (const [rel, content] of files) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const FILES: Array<[string, string]> = [
  ['octipus-plugin.json', '{"name":"demo"}'],
  ['server.mjs', 'console.log(1)'],
  ['lib/a.js', 'a'],
  ['lib/b/c.js', 'c'],
];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('hashPackageContent', () => {
  test('is stable and independent of the order files were written in', async () => {
    const a = await hashPackageContent(pkg(FILES), ID);
    const b = await hashPackageContent(pkg([...FILES].reverse()), ID);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(await hashPackageContent(pkg(FILES), ID)).toBe(a);
  });

  test('changes with a byte, an added, removed or renamed file', async () => {
    const base = await hashPackageContent(pkg(FILES), ID);
    const edited = FILES.map(([p, c]): [string, string] => (p === 'lib/a.js' ? [p, 'A'] : [p, c]));
    expect(await hashPackageContent(pkg(edited), ID)).not.toBe(base);
    expect(await hashPackageContent(pkg([...FILES, ['extra.js', '']]), ID)).not.toBe(base);
    expect(await hashPackageContent(pkg(FILES.slice(1)), ID)).not.toBe(base);
    const renamed = pkg(FILES);
    renameSync(join(renamed, 'lib/a.js'), join(renamed, 'lib/z.js'));
    expect(await hashPackageContent(renamed, ID)).not.toBe(base);
    // An empty directory is no content.
    const withEmptyDir = pkg(FILES);
    mkdirSync(join(withEmptyDir, 'empty'));
    expect(await hashPackageContent(withEmptyDir, ID)).toBe(base);
  });

  test('covers the manifest name and version', async () => {
    const dir = pkg(FILES);
    const base = await hashPackageContent(dir, ID);
    expect(await hashPackageContent(dir, { ...ID, version: '1.0.1' })).not.toBe(base);
    expect(await hashPackageContent(dir, { ...ID, name: 'other' })).not.toBe(base);
  });

  test('leaves nothing out, node_modules/.cache included', async () => {
    const dir = pkg(FILES);
    const base = await hashPackageContent(dir, ID);
    mkdirSync(join(dir, 'node_modules/.cache/babel'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/.cache/babel/x.js'), 'staged()');
    const withCache = await hashPackageContent(dir, ID);
    expect(withCache).not.toBe(base);
    expect(await contentListing(dir, ID)).toContain('"node_modules/.cache/babel/x.js"');
    writeFileSync(join(dir, 'node_modules/dep.js'), 'dep');
    expect(await hashPackageContent(dir, ID)).not.toBe(withCache);
  });

  test('depends only on paths relative to the package root (a staging copy hashes the same)', async () => {
    const dir = pkg(FILES);
    const base = await hashPackageContent(dir, ID);
    const parent = mkdtempSync(join(tmpdir(), 'octipus-integrity-moved-'));
    dirs.push(parent);
    const moved = join(parent, 'demo.installing-1-2');
    renameSync(dir, moved);
    expect(await hashPackageContent(moved, ID)).toBe(base);
    expect(await contentListing(moved, ID)).not.toContain(parent);
  });

  test('a symbolic link that appears after install changes the hash', async () => {
    const dir = pkg(FILES);
    const base = await hashPackageContent(dir, ID);
    symlinkSync('/etc/passwd', join(dir, 'link'));
    expect(await hashPackageContent(dir, ID)).not.toBe(base);
  });

  test('the listing is sorted and quotes paths', async () => {
    const listing = await contentListing(pkg([['b', '1'], ['a\nfile x', '2']]), ID);
    const lines = listing.trimEnd().split('\n');
    expect(lines.slice(0, 3)).toEqual(['octipus-plugin-content/v1', 'name demo', 'version 1.0.0']);
    expect(lines).toHaveLength(5);
    expect(lines[3]).toMatch(/^file [0-9a-f]{64} "a\\nfile x"$/);
    expect(lines[4]).toMatch(/^file [0-9a-f]{64} "b"$/);
  });
});

describe('verifyPackageContent', () => {
  test('ok when the files match the recorded hash', async () => {
    const dir = pkg(FILES);
    const contentHash = await hashPackageContent(dir, ID);
    const recorded: string[] = [];
    const check = await verifyPackageContent(dir, { ...ID, contentHash }, async (h) => { recorded.push(h); });
    expect(check).toEqual({ status: 'ok', hash: contentHash });
    expect(recorded).toEqual([]);
  });

  test('a changed file is a mismatch naming both hashes, and nothing is recorded', async () => {
    const dir = pkg(FILES);
    const contentHash = await hashPackageContent(dir, ID);
    writeFileSync(join(dir, 'server.mjs'), 'process.exit(1)');
    const recorded: string[] = [];
    const check = await verifyPackageContent(dir, { ...ID, contentHash }, async (h) => { recorded.push(h); });
    expect(check.status).toBe('mismatch');
    if (check.status !== 'mismatch') return;
    expect(check.recorded).toBe(contentHash);
    expect(check.actual).toBe(await hashPackageContent(dir, ID));
    expect(check.actual).not.toBe(contentHash);
    expect(recorded).toEqual([]);
  });

  test('re-approving (recording the new hash) makes the changed files pass', async () => {
    const dir = pkg(FILES);
    writeFileSync(join(dir, 'server.mjs'), 'v2');
    const approved = await hashPackageContent(dir, ID);
    expect((await verifyPackageContent(dir, { ...ID, contentHash: approved }, async () => {})).status).toBe('ok');
  });

  test('no recorded hash: the current one is recorded (trust on first use), then checked', async () => {
    const dir = pkg(FILES);
    const recorded: string[] = [];
    const first = await verifyPackageContent(dir, { ...ID, contentHash: null }, async (h) => { recorded.push(h); });
    expect(first.status).toBe('first_use');
    expect(recorded).toEqual([await hashPackageContent(dir, ID)]);
    writeFileSync(join(dir, 'lib/a.js'), 'tampered');
    expect((await verifyPackageContent(dir, { ...ID, contentHash: recorded[0] }, async () => {})).status).toBe('mismatch');
  });
});

describe('isContentHash', () => {
  test('accepts only the recorded form', async () => {
    expect(isContentHash(await hashPackageContent(pkg(FILES), ID))).toBe(true);
    for (const v of [true, false, null, '', 'sha256:', `sha256:${'A'.repeat(64)}`, `sha512:${'a'.repeat(64)}`, `sha256:${'a'.repeat(63)}`, `sha256:${'a'.repeat(64)}\n`]) {
      expect(isContentHash(v)).toBe(false);
    }
  });
});
