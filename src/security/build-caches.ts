import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isInside } from './workspace-fs';

/** Writable personal build state, shared by shell jobs and native CLI jobs.
 * Reuse installed Gradle distributions/dependencies and the owner's adb state;
 * never expose the whole home. Callers must exclude shared-space runs.
 */
export function personalBuildCaches(): { paths: string[]; env: Record<string, string> } {
  const home = realpathSync(homedir());
  const paths = ['.gradle', '.android', '.m2/repository'].map(name => {
    const path = join(home, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const target = realpathSync(path);
    if (isInside(target, home)) throw new Error(`Build cache ${path} must not resolve to the home directory or an ancestor`);
    return path;
  });
  // Robolectric locks its Maven downloads in a file directly under user.home.
  // Bind that file, not the home directory or Maven settings/credentials.
  const lock = join(home, '.robolectric-download-lock');
  try {
    if (lstatSync(lock).isSymbolicLink()) throw new Error('Robolectric lock file must not be a symlink');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  closeSync(openSync(lock, 'a', 0o600));
  paths.push(lock);
  return { paths, env: { GRADLE_USER_HOME: paths[0], ANDROID_USER_HOME: paths[1] } };
}
