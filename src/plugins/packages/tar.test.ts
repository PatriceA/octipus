/**
 * Unpacking a downloaded package (./tar.ts): regular files and directories
 * only, every path inside the target, bounded size and count.
 */
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { makeTar, makeTarGz, paxHeader, paxPath, type TarEntrySpec } from '@/test-helpers/tar';
import { extractTarGz, packageRootIn, readTarEntries, safeEntryPath, TarError } from './tar';

const fresh = () => mkdtempSync(join(tmpdir(), 'octipus-tar-'));
const MANIFEST = { name: 'octipus-plugin.json', data: '{"name":"demo"}' };

async function refused(entries: TarEntrySpec[], pattern: RegExp): Promise<string> {
  const dest = fresh();
  await expect(extractTarGz(makeTarGz(entries), dest)).rejects.toThrow(pattern);
  return dest;
}

describe('extractTarGz', () => {
  test('unpacks files and directories, with modes 0644 or 0755 only', async () => {
    const dest = fresh();
    await extractTarGz(makeTarGz([
      { name: 'package/', type: '5' },
      { name: 'package/octipus-plugin.json', data: '{}' },
      { name: 'package/bin/run.sh', data: '#!/bin/sh\n', mode: 0o4777 },
      { name: 'server.mjs', prefix: 'package/dist', data: 'export {}' },
    ]), dest);
    expect(readFileSync(join(dest, 'package', 'dist', 'server.mjs'), 'utf8')).toBe('export {}');
    expect(lstatSync(join(dest, 'package', 'bin', 'run.sh')).mode & 0o7777).toBe(0o755);
    expect(lstatSync(join(dest, 'package', 'octipus-plugin.json')).mode & 0o7777).toBe(0o644);
    expect(await packageRootIn(dest)).toBe(join(dest, 'package'));
  });

  test('takes long names from pax and GNU headers', async () => {
    const long = `${'d'.repeat(120)}/${'f'.repeat(120)}.js`;
    const dest = fresh();
    await extractTarGz(makeTarGz([
      MANIFEST,
      paxPath(long), { name: 'ignored-short-name', data: 'pax' },
      { name: '././@LongLink', type: 'L', data: `gnu/${'g'.repeat(150)}\0` }, { name: 'ignored', data: 'gnu' },
    ]), dest);
    expect(readFileSync(join(dest, ...long.split('/')), 'utf8')).toBe('pax');
    expect(readFileSync(join(dest, 'gnu', 'g'.repeat(150)), 'utf8')).toBe('gnu');
    expect(existsSync(join(dest, 'ignored-short-name'))).toBe(false);
  });

  test.each([
    ['a parent segment', '../escape.txt'],
    ['a parent segment deeper in', 'package/../../escape.txt'],
    ['an absolute path', '/etc/cron.d/x'],
    ['a drive letter', 'C:/Windows/x'],
    ['a backslash', '..\\escape.txt'],
  ])('refuses %s', async (_what, name) => {
    const dest = await refused([MANIFEST, { name, data: 'x' }], /leaves the package|absolute path|backslash/);
    expect(existsSync(join(dest, '..', 'escape.txt'))).toBe(false);
  });

  test('refuses a pax path that leaves the target', async () => {
    await refused([MANIFEST, paxPath('../../pax-escape'), { name: 'ok', data: 'x' }], /leaves the package/);
  });

  test.each([
    ['1', 'a hard link'],
    ['2', 'a symbolic link'],
    ['3', 'a character device'],
    ['4', 'a block device'],
    ['6', 'a FIFO'],
  ])('refuses entry type %s (%s)', async (type, what) => {
    const dest = await refused([MANIFEST, { name: 'evil', type, linkname: '/etc/passwd' }], new RegExp(what));
    expect(readdirSync(dest).includes('evil')).toBe(false);
  });

  test('refuses a pax linkpath, an unknown type, a duplicate path, and a file over a directory', async () => {
    await refused([paxHeader('linkpath', '/etc/passwd'), { name: 'x', data: '' }], /linkpath/);
    await refused([{ name: 'odd', type: 'Z' }], /unknown type/);
    await refused([MANIFEST, { name: 'a.js', data: '1' }, { name: './a.js', data: '2' }], /twice/);
    await refused([{ name: 'dir/', type: '5' }, { name: 'dir', data: 'x' }], /collides/);
    // A file, then a directory of the same name (or under it): refused, not a raw EEXIST.
    await refused([{ name: 'dir', data: 'x' }, { name: 'dir/', type: '5' }], /collides/);
    await refused([{ name: 'dir', data: 'x' }, { name: 'dir/sub/', type: '5' }], /collides/);
  });

  test('refuses a corrupt header, a truncated archive and something that is not gzip', async () => {
    const tar = makeTar([{ name: 'a.txt', data: 'hello' }]);
    tar[0] ^= 0xff;
    await expect(extractTarGz(gzipSync(tar), fresh())).rejects.toThrow(/checksum/);
    const whole = makeTar([{ name: 'a.txt', data: 'x'.repeat(2000) }]);
    await expect(extractTarGz(gzipSync(whole.subarray(0, 1024)), fresh())).rejects.toThrow(/truncated/);
    await expect(extractTarGz(Buffer.from('plain text'), fresh())).rejects.toThrow(/not a gzip/);
  });

  test('bounds the unpacked size and the number of files', async () => {
    await expect(extractTarGz(makeTarGz([{ name: 'big', data: Buffer.alloc(4096) }]), fresh(), { maxBytes: 1024, maxFiles: 10 }))
      .rejects.toThrow(/more than|larger than/);
    await expect(extractTarGz(makeTarGz([{ name: 'a', data: 'x' }, { name: 'b', data: 'x' }, { name: 'c', data: 'x' }]), fresh(), { maxBytes: 1 << 20, maxFiles: 2 }))
      .rejects.toThrow(/more than 2 files/);
    // A gzip bomb is stopped by the gunzip output cap, before anything is parsed.
    const bomb = gzipSync(Buffer.alloc(8 << 20));
    await expect(extractTarGz(bomb, fresh(), { maxBytes: 1 << 20, maxFiles: 10 })).rejects.toThrow(TarError);
  });

  test('packageRootIn wants the manifest at the root or in the one top-level directory', async () => {
    const dest = fresh();
    await extractTarGz(makeTarGz([{ name: 'a/x', data: '' }, { name: 'b/octipus-plugin.json', data: '{}' }]), dest);
    await expect(packageRootIn(dest)).rejects.toThrow(/no octipus-plugin.json/);
  });
});

describe('safeEntryPath and readTarEntries', () => {
  test('normalises ./ and trailing slashes; the root is null', () => {
    expect(safeEntryPath('./package/./a.js')).toBe('package/a.js');
    expect(safeEntryPath('package/')).toBe('package');
    expect(safeEntryPath('./')).toBeNull();
    expect(() => safeEntryPath('a\0b')).toThrow(/NUL/);
  });

  test('reads a GNU-style empty type flag as a regular file', () => {
    const tar = makeTar([{ name: 'a.txt', data: 'x' }]);
    tar[156] = 0;
    // Fix the checksum after changing the type flag.
    tar.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += tar[i];
    tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    expect(readTarEntries(tar)).toEqual([expect.objectContaining({ kind: 'file', path: 'a.txt' })]);
  });
});
