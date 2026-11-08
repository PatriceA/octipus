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
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

/** The prefix of a recorded hash; a later format would get a new one. */
export const CONTENT_HASH_PREFIX = 'sha256:';
const FORMAT = 'octipus-plugin-content/v1';
/** The signature file in the package root (./signature.ts), the one file the hash leaves out. */
export const SIGNATURE_FILE = 'octipus-plugin.sig';

function fileHash(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolvePromise(hash.digest('hex')));
  });
}

/** The canonical listing of a package directory (what `hashPackageContent` hashes). */
export async function contentListing(dir: string, identity: { name: string; version: string }): Promise<string> {
  const entries: Array<[string, string]> = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const name of await readdir(abs)) {
      const childRel = rel ? `${rel}/${name}` : name;
      const childAbs = join(abs, name);
      const info = await lstat(childAbs);
      if (info.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (info.isFile()) {
        if (childRel === SIGNATURE_FILE) continue;
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
  const lines = [FORMAT, `name ${identity.name}`, `version ${identity.version}`];
  // JSON-quoted paths: a newline in a file name cannot forge another line.
  for (const [rel, what] of entries) lines.push(`${what} ${JSON.stringify(rel)}`);
  return `${lines.join('\n')}\n`;
}

/** The content hash of a package directory, `sha256:<hex>`. */
export async function hashPackageContent(dir: string, identity: { name: string; version: string }): Promise<string> {
  const listing = await contentListing(dir, identity);
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
