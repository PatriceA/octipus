/**
 * Session file service — read/write over WorkspaceFS with versioning.
 *
 * Exercises the behaviours the in-chat file view depends on (Thread 2):
 *   - read text / image / directory / too-large
 *   - write creates + reports a new version
 *   - optimistic concurrency: a stale baseVersion is rejected 409
 *   - containment: traversal outside the workspace root is rejected
 *
 * Uses `WorkspaceFS.withRoot` against an ephemeral tmp dir — no DB, no Docker.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceFS } from '@/security/workspace-fs';
import {
  MAX_FILE_BYTES,
  readSessionFile,
  SessionFileError,
  writeSessionFile,
} from './session-files';

let root: string;
let fs: WorkspaceFS;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'octipus-sf-'));
  fs = WorkspaceFS.withRoot(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.ensureRoot();
});

describe('readSessionFile', () => {
  test('reads a text file with a version and metadata', async () => {
    await writeFile(join(root, 'poem.md'), 'roses are red\nviolets are blue', 'utf-8');
    const result = await readSessionFile(fs, 'poem.md');
    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.content).toBe('roses are red\nviolets are blue');
      expect(result.version).toHaveLength(16);
      expect(result.size).toBeGreaterThan(0);
    }
  });

  test('accepts an absolute path inside the workspace root', async () => {
    await writeFile(join(root, 'abs.txt'), 'hi', 'utf-8');
    const result = await readSessionFile(fs, join(root, 'abs.txt'));
    expect(result.type).toBe('text');
  });

  test('lists a directory sorted dirs-first', async () => {
    await mkdir(join(root, 'd', 'sub'), { recursive: true });
    await writeFile(join(root, 'd', 'a.txt'), 'a', 'utf-8');
    const result = await readSessionFile(fs, 'd');
    expect(result.type).toBe('directory');
    if (result.type === 'directory') {
      expect(result.entries[0].isDirectory).toBe(true);
      expect(result.entries.map((e) => e.name)).toEqual(['sub', 'a.txt']);
    }
  });

  test('returns too-large for files over the cap', async () => {
    await writeFile(join(root, 'big.bin'), Buffer.alloc(MAX_FILE_BYTES + 1));
    const result = await readSessionFile(fs, 'big.bin');
    expect(result.type).toBe('too-large');
  });

  test('flags a NUL-containing file as binary', async () => {
    await writeFile(join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
    const result = await readSessionFile(fs, 'bin.dat');
    expect(result.type).toBe('binary');
  });

  test('returns an image as a data URL', async () => {
    // 1x1 transparent PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    await writeFile(join(root, 'pixel.png'), png);
    const result = await readSessionFile(fs, 'pixel.png');
    expect(result.type).toBe('image');
    if (result.type === 'image') {
      expect(result.mimeType).toBe('image/png');
      expect(result.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    }
  });

  test('throws 404 for a missing file', async () => {
    await expect(readSessionFile(fs, 'nope.txt')).rejects.toMatchObject({ status: 404 });
  });

  test('rejects path traversal outside the workspace root', async () => {
    await expect(readSessionFile(fs, '../../../etc/passwd')).rejects.toBeInstanceOf(SessionFileError);
    await expect(readSessionFile(fs, '../../../etc/passwd')).rejects.toMatchObject({ status: 400 });
  });

  test('rejects a path with a null byte', async () => {
    await expect(readSessionFile(fs, 'a\0b')).rejects.toMatchObject({ status: 400 });
  });
});

describe('writeSessionFile', () => {
  test('creates a new file and reports its version', async () => {
    const out = await writeSessionFile(fs, 'new.md', 'hello');
    expect(out.version).toHaveLength(16);
    const read = await readSessionFile(fs, 'new.md');
    expect(read.type === 'text' && read.content).toBe('hello');
  });

  test('round-trips: read version then write with it succeeds', async () => {
    await writeSessionFile(fs, 'rt.md', 'one');
    const read = await readSessionFile(fs, 'rt.md');
    if (read.type !== 'text') throw new Error('expected text');
    const out = await writeSessionFile(fs, 'rt.md', 'two', read.version);
    expect(out.version).not.toBe(read.version);
    const after = await readSessionFile(fs, 'rt.md');
    expect(after.type === 'text' && after.content).toBe('two');
  });

  test('rejects a stale baseVersion with 409', async () => {
    await writeSessionFile(fs, 'race.md', 'v1');
    await expect(
      writeSessionFile(fs, 'race.md', 'v2', 'deadbeefdeadbeef'),
    ).rejects.toMatchObject({ status: 409, code: 'stale_version' });
  });

  test('rejects a baseVersion on a non-existent file with 409', async () => {
    await expect(
      writeSessionFile(fs, 'ghost.md', 'x', 'deadbeefdeadbeef'),
    ).rejects.toMatchObject({ status: 409 });
  });

  test('rejects content over the cap with 413', async () => {
    const big = 'a'.repeat(MAX_FILE_BYTES + 1);
    await expect(writeSessionFile(fs, 'huge.txt', big)).rejects.toMatchObject({ status: 413 });
  });

  test('rejects traversal on write', async () => {
    await expect(writeSessionFile(fs, '../escape.txt', 'x')).rejects.toMatchObject({ status: 400 });
  });
});
