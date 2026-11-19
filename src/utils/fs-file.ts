/**
 * A small file handle over `node:fs`.
 *
 * The codebase reads and writes files through a handle object — `exists()`,
 * `text()`, `json()`, `arrayBuffer()`, `size` — in roughly sixty places. This
 * keeps that shape while the implementation underneath is plain `node:fs`,
 * which is the whole of it: there is no caching, no pooling and no lifecycle.
 */
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { glob, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface FileHandle {
  readonly path: string;
  exists(): Promise<boolean>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  bytes(): Promise<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Byte length, or 0 when the file is missing — matching the read paths. */
  readonly size: number;
  slice(start: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
  stream(): ReadableStream<Uint8Array>;
}

export function fileAt(path: string): FileHandle {
  return {
    path,
    async exists() { return existsSync(path); },
    text() { return readFile(path, 'utf8'); },
    async json<T>() { return JSON.parse(await readFile(path, 'utf8')) as T; },
    async bytes() { return new Uint8Array(await readFile(path)); },
    async arrayBuffer() { return toArrayBuffer(await readFile(path)); },
    get size() {
      try { return statSync(path).size; } catch { return 0; }
    },
    slice(start: number, end?: number) {
      return {
        async arrayBuffer() {
          // Reads only the requested range. The obvious version — read the
          // file, then `subarray` — loads a whole audio recording to fetch a
          // 44-byte WAV header, which is what `src/voice/stt.ts` asks for.
          const length = end === undefined ? undefined : Math.max(0, end - start);
          const handle = await open(path, 'r');
          try {
            const size = (await handle.stat()).size;
            const want = length ?? Math.max(0, size - start);
            const buf = Buffer.alloc(Math.min(want, Math.max(0, size - start)));
            if (buf.byteLength > 0) await handle.read(buf, 0, buf.byteLength, start);
            return toArrayBuffer(buf);
          } finally {
            await handle.close();
          }
        },
      };
    },
    stream() {
      return Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
    },
  };
}

/**
 * Write a file, creating its directory. Accepts a `Response` because several
 * download paths stream a fetch straight to disk: its body goes to a
 * temporary file beside the target as it arrives (a model is hundreds of
 * megabytes — never held in memory) and takes the target's name only once it
 * is complete, so an interrupted download never leaves a file that looks
 * installed.
 *
 * A response is recognised by its shape, not `instanceof Response`: a fetch
 * that goes through a proxy agent answers with another realm's class.
 */
export async function writeFileAt(
  path: string,
  data: string | Uint8Array | ArrayBuffer | ArrayBufferView | Blob | Response,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = (data as Partial<Response> | null)?.body;
  if (body && typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
    const partial = `${path}.${process.pid}.part`;
    try {
      await pipeline(Readable.fromWeb(body as never), createWriteStream(partial));
      await rename(partial, path);
    } catch (err) {
      await unlink(partial).catch(() => {});
      throw err;
    }
    return;
  }
  if (typeof (data as Blob | Response).arrayBuffer === 'function' && !ArrayBuffer.isView(data)) {
    await writeFile(path, Buffer.from(await (data as Blob | Response).arrayBuffer()));
    return;
  }
  if (data instanceof ArrayBuffer) {
    await writeFile(path, Buffer.from(data));
    return;
  }
  await writeFile(path, data as string | Uint8Array);
}

/** Delete a file; a missing file is not an error. */
export async function removeFile(path: string): Promise<void> {
  try { await unlink(path); } catch { /* already gone */ }
}

/** Glob under a directory. Yields absolute paths unless `absolute` is false. */
export async function* globFiles(
  pattern: string,
  options: { cwd: string; absolute?: boolean },
): AsyncGenerator<string> {
  for await (const entry of glob(pattern, { cwd: options.cwd })) {
    const rel = typeof entry === 'string' ? entry : String(entry);
    // A RELATIVE result is an identifier as much as a path — it becomes the
    // docs indexer's `sourceId` and is prefix-matched against `plans/` and
    // friends — so it is normalised to posix here rather than at each caller.
    // `glob` yields platform separators, and on Windows that both stored a
    // different id for the same file and slipped every `startsWith('…/')`
    // exclusion. Absolute results keep the platform's own separators, which is
    // what `readFile` and friends want.
    if (options.absolute === false) yield rel.split(sep).join('/');
    else yield isAbsolute(rel) ? rel : join(options.cwd, rel);
  }
}

function toArrayBuffer(buf: Uint8Array): ArrayBuffer {
  // `Buffer` views a pooled allocation, so the underlying `.buffer` is longer
  // than the file and shared with unrelated reads. Copy the view's own range.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
