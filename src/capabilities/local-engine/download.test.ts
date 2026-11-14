import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { downloadVerified, sha256File } from './download';

const body = Buffer.from('x'.repeat(50_000));
const sha = createHash('sha256').update(body).digest('hex');
let server: Server;
let base = '';
let dir = '';
let dropFirst = false;
const ranges: string[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'octipus-dl-'));
  server = createServer((req, res) => {
    const range = req.headers.range;
    if (range) ranges.push(range);
    const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    const slice = body.subarray(start);
    res.writeHead(range ? 206 : 200, { 'content-length': String(slice.length) });
    if (dropFirst && !range) {
      dropFirst = false;
      res.write(slice.subarray(0, 10_000), () => res.destroy());
      return;
    }
    res.end(slice);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

describe('downloadVerified', () => {
  test('a matching download is kept, and nothing partial is left', async () => {
    const target = join(dir, 'ok.bin');
    const seen: number[] = [];
    await downloadVerified(`${base}/f`, target, sha, { size: body.length, onProgress: (done) => seen.push(done) });
    expect(await sha256File(target)).toBe(sha);
    expect(seen.at(-1)).toBe(body.length);
    expect(await stat(`${target}.part`).catch(() => null)).toBeNull();
  });

  test('a checksum mismatch is refused and removed', async () => {
    const target = join(dir, 'bad.bin');
    await expect(downloadVerified(`${base}/f`, target, '0'.repeat(64))).rejects.toThrow(/Checksum mismatch/);
    expect(await stat(target).catch(() => null)).toBeNull();
    expect(await stat(`${target}.part`).catch(() => null)).toBeNull();
  });

  test('more bytes than pinned are refused', async () => {
    await expect(downloadVerified(`${base}/f`, join(dir, 'big.bin'), sha, { size: 1000 })).rejects.toThrow(/larger than the pinned/);
  });

  test('a dropped connection resumes with Range', async () => {
    dropFirst = true;
    const target = join(dir, 'resumed.bin');
    await downloadVerified(`${base}/f`, target, sha, { size: body.length });
    expect(ranges.some((r) => /^bytes=\d+-$/.test(r) && r !== 'bytes=0-')).toBe(true);
    expect(Buffer.compare(await readFile(target), body)).toBe(0);
  });

  test('a partial file from an earlier run is resumed', async () => {
    const target = join(dir, 'earlier.bin');
    await writeFile(`${target}.part`, body.subarray(0, 20_000));
    ranges.length = 0;
    await downloadVerified(`${base}/f`, target, sha);
    expect(ranges).toContain('bytes=20000-');
    expect(await sha256File(target)).toBe(sha);
  });
});
