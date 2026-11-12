/**
 * Content pinning for plugin packages (docs/PLUGIN-PACKAGES.md#content-pinning).
 *
 * When a package is installed, upgraded or its content approved, a hash of
 * every file in its directory is recorded on its row. Before its server
 * starts, the hash is recomputed; a package whose files changed since then is
 * not started until an admin approves the new content. A package installed
 * before pinning existed has no hash: the first start records one (trust on
 * first use).
 *
 * The hash is sha256 over a canonical listing: a header naming the format,
 * the package name and version, then one line per entry sorted by its
 * relative path (`/`-separated), each with the sha256 of the file's bytes.
 * Directory order, timestamps and permissions do not count; any byte, any
 * added, removed or renamed file does. Nothing is left out: a cache directory
 * a build tool writes on its own is still a place running code could stage
 * executable content in. Only paths relative to the package root enter the
 * listing, so a staging copy hashes the same as the installed directory.
 *
 * One file is left out: the signature (`octipus-plugin.sig`, a regular file in
 * the package root, ./signature.ts), since it signs this hash and cannot be
 * part of it. It is not code the package runs, and swapping it changes no
 * byte the server sees; whether it is valid is checked on its own.
 *
 * The listing file (`marketplace.json`, a regular file in the package root)
 * is marketplace metadata: title, tags, screenshots, the author's name. It is
 * not package content, so editing a listing must never change what was
 * signed. A package's SOURCE (what `octi plugin hash`, `pack`, `sign` and
 * `validate` read: `{ source: true }`) is hashed without it, and install
 * leaves it out of the copy it installs (service.ts), so an installed package
 * never has one. The installed directory is hashed without the option: a
 * `marketplace.json` that appears there later is content like any other file
 * and changes the hash.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

/** The prefix of a recorded hash; a later format would get a new one. */
export const CONTENT_HASH_PREFIX = 'sha256:';
const FORMAT = 'octipus-plugin-content/v1';
const UI_FORMAT = 'octipus-plugin-ui/v1';
/** The signature file in the package root (./signature.ts), the one file the hash leaves out. */
export const SIGNATURE_FILE = 'octipus-plugin.sig';
/** The marketplace listing file in the package root: left out of a source hash and of an install (see above). */
export const LISTING_FILE = 'marketplace.json';

/** How a directory is hashed: `source` leaves the listing file out (a package before it is installed). */
export interface HashOptions {
  source?: boolean;
}

function fileHash(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolvePromise(hash.digest('hex')));
  });
}

/** Every entry under `dir` as `[relative path, "file <sha256>" | "link <sha256>" | "special"]`, sorted by path; `skip` leaves files out. */
async function treeEntries(dir: string, skip: (rel: string) => boolean): Promise<Array<[string, string]>> {
  const entries: Array<[string, string]> = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const name of await readdir(abs)) {
      const childRel = rel ? `${rel}/${name}` : name;
      const childAbs = join(abs, name);
      const info = await lstat(childAbs);
      if (info.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (info.isFile()) {
        if (skip(childRel)) continue;
        entries.push([childRel, `file ${await fileHash(childAbs)}`]);
      } else if (info.isSymbolicLink()) {
        // Install refuses links; one that appears later must change the hash.
        entries.push([childRel, `link ${createHash('sha256').update(await readlink(childAbs)).digest('hex')}`]);
      } else {
        entries.push([childRel, 'special']);
      }
    }
  };
  await walk(dir, '');
  // Code-unit order, independent of locale and of the order the file system lists entries in.
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries;
}

/** The canonical listing of a package directory (what `hashPackageContent` hashes). */
export async function contentListing(dir: string, identity: { name: string; version: string }, opts: HashOptions = {}): Promise<string> {
  const entries = await treeEntries(dir, (rel) => rel === SIGNATURE_FILE || (opts.source === true && rel === LISTING_FILE));
  const lines = [FORMAT, `name ${identity.name}`, `version ${identity.version}`];
  // JSON-quoted paths: a newline in a file name cannot forge another line.
  for (const [rel, what] of entries) lines.push(`${what} ${JSON.stringify(rel)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * The hash of a package's page directory (`ui.dir`), for its permissions
 * summary (`ui.sha256`): hex sha256 over
 *
 *   octipus-plugin-ui/v1
 *   file <sha256 of the bytes> "<path relative to the ui directory>"   one line per file, sorted by path
 *
 * each line ending in a newline (links and special files as in the content
 * listing). Nothing is left out. Null when the directory cannot be read.
 */
export async function uiTreeHash(uiDir: string): Promise<string | null> {
  let entries: Array<[string, string]>;
  try {
    entries = await treeEntries(uiDir, () => false);
  } catch {
    return null;
  }
  const lines = [UI_FORMAT, ...entries.map(([rel, what]) => `${what} ${JSON.stringify(rel)}`)];
  return createHash('sha256').update(`${lines.join('\n')}\n`).digest('hex');
}

/** The hex sha256 of one file's bytes, or null when it cannot be read. */
export async function fileSha256(path: string): Promise<string | null> {
  try {
    return await fileHash(path);
  } catch {
    return null;
  }
}

/** The content hash of a package directory, `sha256:<hex>`. */
export async function hashPackageContent(dir: string, identity: { name: string; version: string }, opts: HashOptions = {}): Promise<string> {
  const listing = await contentListing(dir, identity, opts);
  return `${CONTENT_HASH_PREFIX}${createHash('sha256').update(listing).digest('hex')}`;
}

/** What `verifyPackageContent` found. */
export type ContentCheck =
  | { status: 'ok'; hash: string }
  | { status: 'first_use'; hash: string }
  | { status: 'mismatch'; recorded: string; actual: string };

/** The problem shown for a package whose files changed since they were approved. */
export const CONTENT_MISMATCH_PROBLEM = 'Modified since it was approved (hash mismatch); approve its content to run it';

/** Whether `value` is a content hash in the recorded form (`sha256:<64 hex>`). */
export function isContentHash(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

/**
 * Compare a package directory against the hash recorded for it. With no
 * recorded hash, the current one is handed to `record` (trust on first use).
 */
export async function verifyPackageContent(
  dir: string,
  pkg: { name: string; version: string; contentHash: string | null },
  record: (hash: string) => Promise<void>,
): Promise<ContentCheck> {
  const actual = await hashPackageContent(dir, pkg);
  if (pkg.contentHash === null) {
    await record(actual);
    return { status: 'first_use', hash: actual };
  }
  if (pkg.contentHash !== actual) return { status: 'mismatch', recorded: pkg.contentHash, actual };
  return { status: 'ok', hash: actual };
}
