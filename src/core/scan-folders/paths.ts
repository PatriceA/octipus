/**
 * Which directories may be scan folders (docs/SCAN-FOLDERS.md#paths). A scan
 * folder reads every file put into it and files it as a document, so it must
 * not be pointed at the system or at Octipus's own data: those would be read
 * into the documents (keys, the database) or filed in a loop (the documents
 * directory itself).
 */
import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getConfig } from '@/config';

export class ScanFolderPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanFolderPathError';
  }
}

/** System directories a scan folder may not be in or contain. */
const SYSTEM_ROOTS = [
  '/etc', '/proc', '/sys', '/dev', '/boot', '/root', '/bin', '/sbin', '/usr', '/lib', '/lib64', '/opt',
  '/var/lib', '/var/log', '/var/run', '/var/spool', '/run', '/snap',
  '/System', '/Library', '/Applications', '/private/etc', '/private/var/db', '/private/var/log',
  'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData',
];

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p;
}

/** A path as the file system sees it: links resolved when it exists, as given when not. */
async function real(p: string): Promise<string> {
  const resolved = resolve(expandHome(p));
  return realpath(resolved).catch(() => resolved);
}

/**
 * Octipus's own data and code: the workspace, the documents, the embedded
 * database, the state directory (`~/.octipus`: extensions, skills, keys)
 * and the install directory. Each resolved through links, as the candidate is.
 */
async function protectedRoots(): Promise<string[]> {
  const config = getConfig();
  const roots = [
    config.workspace.rootPath,
    config.workspace.documentsPath,
    process.env.DATA_DIR || config.database?.dataDir,
    join(homedir(), '.octipus'),
    process.cwd(),
  ].filter((p): p is string => !!p);
  return Promise.all(roots.map(real));
}

/** `inner` is `outer` or inside it. */
function within(inner: string, outer: string): boolean {
  const rel = relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The directory `input` names, resolved (no symbolic link left in it), or a
 * `ScanFolderPathError`: not absolute, missing, not a directory, a system
 * directory, overlapping Octipus's data, or not writable when files are to
 * be moved aside or deleted after filing.
 */
export async function checkFolderPath(input: string): Promise<string> {
  const raw = input.trim();
  if (!raw || !isAbsolute(raw)) throw new ScanFolderPathError('The path must be absolute');
  let path: string;
  try {
    path = await realpath(raw);
  } catch {
    throw new ScanFolderPathError('The directory does not exist');
  }
  if (!(await lstat(path)).isDirectory()) throw new ScanFolderPathError('The path is not a directory');
  if (path === sep || /^[A-Za-z]:\\?$/.test(path)) throw new ScanFolderPathError('The root directory cannot be a scan folder');
  for (const root of SYSTEM_ROOTS) {
    // Both spellings: macOS resolves /var and /etc to /private/….
    if (within(path, root) || within(path, await real(root))) throw new ScanFolderPathError(`A system directory (${root}) cannot be a scan folder`);
  }
  // Hidden directories hold configuration and keys (~/.ssh, ~/.config, ~/.aws).
  if (path.split(/[\\/]/).some((part) => part.startsWith('.'))) {
    throw new ScanFolderPathError('A hidden directory, or one inside a hidden directory, cannot be a scan folder');
  }
  for (const root of await protectedRoots()) {
    if (within(path, root) || within(root, path)) throw new ScanFolderPathError('A scan folder cannot be inside Octipus\'s own data, or contain it');
  }
  try {
    await access(path, constants.R_OK | constants.W_OK);
  } catch {
    throw new ScanFolderPathError('Octipus needs to read the directory and remove filed files from it');
  }
  return path;
}
