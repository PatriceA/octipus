import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { fileAt, removeFile, writeFileAt } from './fs-file';

const dir = mkdtempSync(join(tmpdir(), 'octipus-fsfile-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('fileAt', () => {
  test('reads text, json and bytes, and reports size and existence', async () => {
    const p = join(dir, 'a.json');
    writeFileSync(p, '{"n":1}');
    const f = fileAt(p);
    expect(await f.exists()).toBe(true);
    expect(await f.text()).toBe('{"n":1}');
    expect(await f.json()).toEqual({ n: 1 });
    expect(f.size).toBe(7);
    expect([...(await f.bytes())].slice(0, 1)).toEqual([123]);
  });

  test('a missing file reports absent and size 0 rather than throwing', async () => {
    const f = fileAt(join(dir, 'nope'));
    expect(await f.exists()).toBe(false);
    expect(f.size).toBe(0);
  });

  test('slice reads only the requested range', async () => {
    // `stt.ts` slices 44 bytes off a WAV to read its header; the naive version
    // (read all, then subarray) pulls the whole recording into memory.
    const p = join(dir, 'big.bin');
    writeFileSync(p, Buffer.concat([Buffer.from('HEADER--'), Buffer.alloc(1_000_000, 7)]));
    const head = Buffer.from(await fileAt(p).slice(0, 8).arrayBuffer());
    expect(head.toString('utf8')).toBe('HEADER--');
    expect(head.byteLength).toBe(8);

    // A range past the end clamps instead of over-allocating.
    const tail = Buffer.from(await fileAt(p).slice(1_000_000).arrayBuffer());
    expect(tail.byteLength).toBe(8);
  });

  test('arrayBuffer returns the file, not the pool the Buffer sits in', async () => {
    const p = join(dir, 'small.bin');
    writeFileSync(p, Buffer.from([1, 2, 3]));
    const buf = await fileAt(p).arrayBuffer();
    expect(buf.byteLength).toBe(3);
  });
});

describe('writeFileAt', () => {
  test('creates missing directories and accepts a Response', async () => {
    const p = join(dir, 'nested/deep/out.txt');
    await writeFileAt(p, new Response('from-a-response'));
    expect(await fileAt(p).text()).toBe('from-a-response');
  });

  test('removeFile is a no-op on a file that is already gone', async () => {
    await expect(removeFile(join(dir, 'never-existed'))).resolves.toBeUndefined();
  });
});
