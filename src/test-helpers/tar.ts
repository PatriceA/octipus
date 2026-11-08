/**
 * Building tar archives in tests, including the ones a reader must refuse
 * (links, devices, `..` paths): each entry's header is written by hand in
 * POSIX ustar form, so a test can put anything in it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export interface TarEntrySpec {
  name: string;
  /** Type flag: '0' file (default), '5' directory, '1' hard link, '2' symlink, '3'/'4' devices, '6' FIFO, 'x' pax, 'L' GNU long name. */
  type?: string;
  data?: Buffer | string;
  mode?: number;
  linkname?: string;
  /** The ustar prefix field (a path prefix joined with `/`). */
  prefix?: string;
}

function field(block: Buffer, start: number, length: number, value: string): void {
  block.write(value.slice(0, length), start, length, 'utf8');
}

function octalField(block: Buffer, start: number, length: number, value: number): void {
  field(block, start, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

function header(e: TarEntrySpec, size: number): Buffer {
  const h = Buffer.alloc(512);
  field(h, 0, 100, e.name);
  octalField(h, 100, 8, e.mode ?? (e.type === '5' ? 0o755 : 0o644));
  octalField(h, 108, 8, 0);
  octalField(h, 116, 8, 0);
  octalField(h, 124, 12, size);
  octalField(h, 136, 12, 0);
  h.write(e.type ?? '0', 156, 1, 'ascii');
  field(h, 157, 100, e.linkname ?? '');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  field(h, 345, 155, e.prefix ?? '');
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  field(h, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return h;
}

/** An uncompressed tar of the entries, with the two closing zero blocks. */
export function makeTar(entries: TarEntrySpec[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = typeof e.data === 'string' ? Buffer.from(e.data) : e.data ?? Buffer.alloc(0);
    parts.push(header(e, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** A gzip-compressed tar of the entries. */
export function makeTarGz(entries: TarEntrySpec[]): Buffer {
  return gzipSync(makeTar(entries));
}

/** A pax extended header entry setting `key` (path, linkpath, size…) for the entry after it. */
export function paxHeader(key: string, value: string): TarEntrySpec {
  const record = (len: number) => `${len} ${key}=${value}\n`;
  let len = record(0).length;
  while (Buffer.byteLength(record(len)) !== len) len = Buffer.byteLength(record(len));
  return { name: 'PaxHeader', type: 'x', data: record(len) };
}

/** A pax extended header entry setting `path` for the entry after it. */
export function paxPath(path: string): TarEntrySpec {
  return paxHeader('path', path);
}

/** The entries of a directory on disk, under `prefix/` (directories first, then files, sorted). */
export function entriesOfDir(dir: string, prefix = ''): TarEntrySpec[] {
  const out: TarEntrySpec[] = [];
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (statSync(childAbs).isDirectory()) {
        out.push({ name: `${childRel}/`, type: '5' });
        walk(childAbs, childRel);
      } else {
        out.push({ name: childRel, data: readFileSync(childAbs), mode: statSync(childAbs).mode & 0o777 });
      }
    }
  };
  if (prefix) out.push({ name: `${prefix}/`, type: '5' });
  walk(dir, prefix);
  return out;
}
