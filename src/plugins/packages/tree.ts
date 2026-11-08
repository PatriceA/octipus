/**
 * The shape check of a package directory, before it is installed or signed:
 * no symbolic links (a link could carry a host file into the plugin
 * directory, or out of it, or have a write land elsewhere), no special
 * files, and bounded size and file count.
 */
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Largest package a directory install copies (bytes). */
export const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;
/** Most files a directory install copies. */
export const MAX_PACKAGE_FILES = 20_000;

export class PackageTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageTreeError';
  }
}

/** Walk a package directory; throw `PackageTreeError` on the first thing it may not contain. */
export async function checkPackageTree(dir: string): Promise<void> {
  let bytes = 0;
  let files = 0;
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new PackageTreeError(`The package contains a symbolic link (${full}); copy real files instead`);
      if (info.isDirectory()) await walk(full);
      else if (info.isFile()) {
        files += 1;
        bytes += info.size;
        if (files > MAX_PACKAGE_FILES) throw new PackageTreeError(`The package has more than ${MAX_PACKAGE_FILES} files`);
        if (bytes > MAX_PACKAGE_BYTES) throw new PackageTreeError(`The package is larger than ${MAX_PACKAGE_BYTES / 1024 / 1024} MB`);
      } else throw new PackageTreeError(`The package contains a special file (${full})`);
    }
  };
  await walk(dir);
}
