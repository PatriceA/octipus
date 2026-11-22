import { chmodSync, linkSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { checkDisk, readFileForBuffer, writeFileForBuffer } from './workspace-fs-bridge';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fs-bridge-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function read(path: string) {
  const r = readFileForBuffer(path);
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe('reading', () => {
  test('a CRLF file comes in without \\r in its lines and is saved back as CRLF', () => {
    const path = join(dir, 'win.txt');
    writeFileSync(path, 'one\r\ntwo\r\n');
    const r = read(path);
    expect(r.text).toBe('one\ntwo\n');
    expect(r.disk.eol).toBe('\r\n');
    expect(writeFileForBuffer(path, 'one\ntwo\nthree\n', r.disk).ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('one\r\ntwo\r\nthree\r\n');
  });

  test('a byte-order mark is kept off the buffer and written back', () => {
    const path = join(dir, 'bom.txt');
    writeFileSync(path, '﻿hello');
    const r = read(path);
    expect(r.text).toBe('hello');
    writeFileForBuffer(path, 'hello!', r.disk);
    expect(readFileSync(path).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  test('mixed line endings are reported; a lone CR stays in the text', () => {
    const path = join(dir, 'mixed.txt');
    writeFileSync(path, 'a\r\nb\nc\rd\r\n');
    const r = read(path);
    expect(r.mixedEol).toBe(true);
    expect(r.disk.eol).toBe('\r\n');
    expect(r.text).toBe('a\nb\nc\rd\n');
  });

  test('a file that is not UTF-8 is refused with the reason, not opened and rewritten', () => {
    const path = join(dir, 'latin1.txt');
    writeFileSync(path, Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café" in Latin-1
    const r = readFileForBuffer(path);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/not valid UTF-8/);
  });

  test('binary, missing, folders and big files are refused with a reason each', () => {
    writeFileSync(join(dir, 'bin'), Buffer.from([1, 0, 2]));
    writeFileSync(join(dir, 'big'), Buffer.alloc(6 * 1024 * 1024, 0x61));
    const error = (p: string) => { const r = readFileForBuffer(p); return r.ok ? '' : r.error; };
    expect(error(join(dir, 'bin'))).toMatch(/binary/);
    expect(error(join(dir, 'nope'))).toMatch(/no such file/);
    expect(error(dir)).toMatch(/is a folder/);
    expect(error(join(dir, 'big'))).toMatch(/up to 5 MB/);
  });
});

describe('saving', () => {
  test('is atomic: a rename over the file, no temporary file left behind, mode kept', () => {
    const path = join(dir, 'script.sh');
    writeFileSync(path, 'echo old\n');
    chmodSync(path, 0o751);
    const before = statSync(path).ino;
    const r = read(path);
    const saved = writeFileForBuffer(path, 'echo new\n', r.disk);
    expect(saved.ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('echo new\n');
    expect(statSync(path).mode & 0o777).toBe(0o751);
    expect(statSync(path).ino).not.toBe(before); // a new file renamed into place
    expect(readdirSync(dir)).toEqual(['script.sh']);
  });

  test('writes through a symlink to its target, keeping the link', () => {
    const target = join(dir, 'real.txt');
    const link = join(dir, 'link.txt');
    writeFileSync(target, 'a');
    symlinkSync(target, link);
    writeFileForBuffer(link, 'b', read(link).disk);
    expect(readFileSync(target, 'utf8')).toBe('b');
    expect(readdirSync(dir).sort()).toEqual(['link.txt', 'real.txt']);
  });

  test('a file with another hard link is written in place, so both names see the change', () => {
    const path = join(dir, 'a.txt');
    writeFileSync(path, 'one');
    linkSync(path, join(dir, 'b.txt'));
    writeFileForBuffer(path, 'two', read(path).disk);
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('two');
  });

  test('a new file gets LF and no BOM', () => {
    const path = join(dir, 'new.txt');
    expect(writeFileForBuffer(path, 'x\ny', null).ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('x\ny');
  });

  test('a failure is reported with a reason', () => {
    const r = writeFileForBuffer(join(dir, 'missing-folder', 'x.txt'), 'x', null);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Cannot save .*no such file/);
  });
});

describe('external changes', () => {
  test('a different content on disk is a change; a touch that keeps it is not', () => {
    const path = join(dir, 'f.txt');
    writeFileSync(path, 'same');
    const r = read(path);
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    expect(checkDisk(path, r.disk, r.text).changed).toBe(false);
    writeFileSync(path, 'different');
    expect(checkDisk(path, r.disk, r.text)).toEqual({ changed: true, deleted: false });
  });

  test('a deleted file is a change', () => {
    const path = join(dir, 'gone.txt');
    writeFileSync(path, 'x');
    const r = read(path);
    rmSync(path);
    expect(checkDisk(path, r.disk, r.text)).toEqual({ changed: true, deleted: true });
  });
});
