/**
 * Packing a plugin package into a reproducible `.tar.gz`
 * (docs/PLUGIN-PACKAGES.md#packing-and-publishing): `octi plugin pack`, what
 * a marketplace's CI builds and its publishing machine rebuilds and compares
 * byte for byte before it signs.
 *
 * The same files give the same bytes, wherever and whenever they are packed:
 *
 * - every file of the package, `octipus-plugin.sig` included when present;
 *   the listing file (`marketplace.json` in the root) is never packed: it is
 *   listing metadata, not content, and the content hash leaves it out too
 *   (./integrity.ts);
 * - under one top-level directory `<name>-<version>/`, entries sorted by
 *   their relative path (code-unit order), each directory before what it
 *   holds;
 * - POSIX ustar headers, a pax `path` record only for a path that does not
 *   fit ustar's name and prefix fields; mtime 0, uid and gid 0, empty uname
 *   and gname, mode 0644 or 0755 for a file (0755 when any execute bit is set)
 *   and 0755 for a directory;
 * - gzip written here, not by zlib's own wrapper: mtime 0, no file name, OS
 *   byte 255 ("unknown": zlib writes the platform it was built on, which
 *   differs between Linux and macOS), around a raw deflate stream at level 9.
 *
 * The tree is checked first as install checks it (./tree.ts): no links, no
 * special files, the size and file-count limits. What it packs is what the
 * remote-install reader (./tar.ts) unpacks.
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { constants, crc32, deflateRawSync } from 'node:zlib';
import { PLUGIN_MANIFEST_FILE, type PluginManifest } from '@/shared/plugin-package';
import { hashPackageContent, LISTING_FILE } from './integrity';
import { parseManifest } from './manifest';
import { checkPackageTree } from './tree';

const BLOCK = 512;
/** The deflate level: fixed, so the compressed bytes depend only on the input. */
export const PACK_GZIP_LEVEL = 9;

/** One entry to pack: a directory, or a regular file with its bytes and whether it is executable. */
type PackEntry = { kind: 'dir'; rel: string } | { kind: 'file'; rel: string; data: Buffer; executable: boolean };

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The entries of a package directory, sorted, the listing file left out. */
async function packEntries(dir: string): Promise<PackEntry[]> {
  const entries: PackEntry[] = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const name of await readdir(abs)) {
      const childRel = rel ? `${rel}/${name}` : name;
      const childAbs = join(abs, name);
      const info = await lstat(childAbs);
      if (info.isDirectory()) {
        entries.push({ kind: 'dir', rel: childRel });
        await walk(childAbs, childRel);
      } else if (info.isFile()) {
        if (childRel === LISTING_FILE) continue;
        entries.push({ kind: 'file', rel: childRel, data: await readFile(childAbs), executable: (info.mode & 0o111) !== 0 });
      } else {
        // checkPackageTree refuses these first; a tree changed in between is refused here.
        throw new Error(`${childAbs} is neither a file nor a directory`);
      }
    }
  };
  await walk(dir, '');
  return entries.sort((a, b) => byCodeUnit(a.rel, b.rel));
}

function writeString(block: Buffer, text: string, offset: number, length: number): void {
  block.write(text, offset, length, 'utf8');
}

/** An octal field: zero-padded digits and a NUL, `length` bytes in all. */
function writeOctal(block: Buffer, value: number, offset: number, length: number): void {
  writeString(block, `${value.toString(8).padStart(length - 1, '0')}\0`, offset, length);
}

/**
 * Split a path into ustar's prefix (155 bytes) and name (100 bytes) at a
 * `/`, or null when it does not fit.
 */
function ustarSplit(path: string): { prefix: string; name: string } | null {
  if (Buffer.byteLength(path) <= 100) return { prefix: '', name: path };
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name !== '') return { prefix, name };
  }
  return null;
}

function header(fields: { name: string; prefix: string; mode: number; size: number; type: '0' | '5' | 'x' }): Buffer {
  const block = Buffer.alloc(BLOCK);
  writeString(block, fields.name, 0, 100);
  writeOctal(block, fields.mode, 100, 8);
  writeOctal(block, 0, 108, 8); // uid
  writeOctal(block, 0, 116, 8); // gid
  writeOctal(block, fields.size, 124, 12);
  writeOctal(block, 0, 136, 12); // mtime
  block.fill(0x20, 148, 156); // checksum, counted as spaces
  writeString(block, fields.type, 156, 1);
  writeString(block, 'ustar\0', 257, 6);
  writeString(block, '00', 263, 2);
  // uname (265) and gname (297) stay empty.
  writeOctal(block, 0, 329, 8); // devmajor
  writeOctal(block, 0, 337, 8); // devminor
  writeString(block, fields.prefix, 345, 155);
  let sum = 0;
  for (const byte of block) sum += byte;
  writeString(block, `${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return block;
}

function padded(data: Buffer): Buffer[] {
  const rest = data.length % BLOCK;
  return rest === 0 ? [data] : [data, Buffer.alloc(BLOCK - rest)];
}

/** A pax record, `<length> <key>=<value>\n`, its length counting itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body);
  while (Buffer.byteLength(`${length}${body}`) !== length) length = Buffer.byteLength(`${length}${body}`);
  return `${length}${body}`;
}

/** The headers (and data) of one entry, with a pax header first when its path does not fit ustar. */
function entryBlocks(path: string, entry: { mode: number; type: '0' | '5'; data?: Buffer }): Buffer[] {
  const size = entry.data?.length ?? 0;
  const blocks: Buffer[] = [];
  let split = ustarSplit(path);
  if (split === null) {
    const pax = Buffer.from(paxRecord('path', path), 'utf8');
    blocks.push(header({ name: 'PaxHeader', prefix: '', mode: 0o644, size: pax.length, type: 'x' }), ...padded(pax));
    // The ustar name a pax-unaware reader would see: the tail of the path, cut on a character boundary.
    let tail = path;
    while (Buffer.byteLength(tail) > 100) tail = tail.slice(1);
    split = { prefix: '', name: tail };
  }
  blocks.push(header({ ...split, mode: entry.mode, size, type: entry.type }));
  if (entry.data && entry.data.length > 0) blocks.push(...padded(entry.data));
  return blocks;
}

/** A gzip member around a raw deflate stream: mtime 0, no name, OS "unknown", the same bytes on every platform. */
function gzip(data: Buffer): Buffer {
  const head = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, PACK_GZIP_LEVEL === 9 ? 0x02 : 0x00, 0xff]);
  const body = deflateRawSync(data, { level: PACK_GZIP_LEVEL, memLevel: 8, windowBits: 15, strategy: constants.Z_DEFAULT_STRATEGY });
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(crc32(data) >>> 0, 0);
  tail.writeUInt32LE(data.length >>> 0, 4);
  return Buffer.concat([head, body, tail]);
}

/** What `packPackage` made. */
export interface PackResult {
  /** The `.tar.gz` bytes. */
  tarball: Buffer;
  /** sha256 hex of the tarball bytes (what an index lists as `sha256`). */
  sha256: string;
  /** The package's content hash (`sha256:<hex>`, the source hash: what `sign` signs and install records). */
  contentHash: string;
  manifest: PluginManifest;
  /** The top-level directory in the archive, `<name>-<version>`. */
  root: string;
}

/**
 * Pack the package in `dir`. Throws `PackageTreeError` for a tree install
 * would refuse, `ManifestError` or `SyntaxError` for a manifest it would refuse.
 */
export async function packPackage(dir: string): Promise<PackResult> {
  await checkPackageTree(dir);
  const manifest = parseManifest(JSON.parse(await readFile(join(dir, PLUGIN_MANIFEST_FILE), 'utf8')));
  const root = `${manifest.name}-${manifest.version}`;
  const blocks: Buffer[] = [...entryBlocks(`${root}/`, { mode: 0o755, type: '5' })];
  for (const entry of await packEntries(dir)) {
    const path = `${root}/${entry.rel}`;
    if (entry.kind === 'dir') blocks.push(...entryBlocks(`${path}/`, { mode: 0o755, type: '5' }));
    else blocks.push(...entryBlocks(path, { mode: entry.executable ? 0o755 : 0o644, type: '0', data: entry.data }));
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  const tarball = gzip(Buffer.concat(blocks));
  const contentHash = await hashPackageContent(dir, manifest, { source: true });
  return { tarball, sha256: createHash('sha256').update(tarball).digest('hex'), contentHash, manifest, root };
}
