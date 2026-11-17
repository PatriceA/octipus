import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { configuredExecutionEnvironments, pathInEnvironment } from '@/security/execution-environments';
import { getPermissionManager } from '@/security/permissions';
import type { ConnectionPrincipal } from '@/security/credential-connections';
import { runGit } from './host-collector';
import { PluginPackageError } from './service';

export function repositoryRemotePath(remote: string): string | null {
  let path: string;
  try { path = remote.includes('://') ? new URL(remote).pathname : remote.match(/^[^@/]+@[^:]+:(.+)$/)?.[1] ?? ''; } catch { return null; }
  path = '/' + path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '') + '.git';
  return /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.git$/.test(path) ? path : null;
}

/** Bounded discovery in an existing environment; never runs a shell or fetch. */
export async function setupRepositories(caller: ConnectionPrincipal, environmentId: string, root: string, repository?: string) {
  const environment = configuredExecutionEnvironments().find(e => e.id === environmentId && e.enabled && e.userId === caller.userId && (e.workspaceId === null || e.workspaceId === caller.workspaceId));
  if (caller.space || !environment || environment.backend !== 'host') throw new PluginPackageError('invalid', 'Choose an available workstation environment. Repository discovery is not supported on remote or sandbox environments.');
  const readable = async (path: string) => {
    for (const tool of ['git', 'filesystem']) if ((await getPermissionManager().check(caller.userId, tool, 'read', { path }, { sessionId: '', workspaceId: caller.workspaceId ?? null })).level === 'DENY') return false;
    return true;
  };
  if (!await readable(repository ?? root)) throw new PluginPackageError('invalid', 'Your rules deny reads of the selected folder.');
  const roots = (await Promise.all(environment.roots.map(p => realpath(p).catch(error => { if (['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return null; throw error; })))).filter((p): p is string => p !== null);
  const folder = await realpath(root);
  if (!roots.some(p => pathInEnvironment(p, folder))) throw new PluginPackageError('invalid', 'The folder is outside this environment.');
  if (!await readable(folder)) throw new PluginPackageError('invalid', 'Your rules deny reads of the selected folder.');
  if (!repository) {
    const items = await readdir(folder, { withFileTypes: true });
    const repos: Array<{ name: string; path: string }> = [];
    const candidates = items.filter(i => i.isDirectory()).slice(0, 250);
    let hidden = 0;
    if (await stat(join(folder, '.git')).catch(() => null)) repos.push({ name: basename(folder), path: folder });
    for (const item of candidates) {
      const path = join(folder, item.name);
      if (!await readable(path)) { hidden++; continue; }
      const git = await stat(join(path, '.git')).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
      if (git) repos.push({ name: item.name, path });
    }
    return { repositories: repos, hidden, truncated: items.filter(i => i.isDirectory()).length > 250 };
  }
  const cwd = await realpath(repository);
  if (!pathInEnvironment(folder, cwd)) throw new PluginPackageError('invalid', 'The repository is outside the selected folder.');
  if (!await readable(cwd)) throw new PluginPackageError('invalid', 'Your rules deny reads of the selected repository.');
  const signal = AbortSignal.timeout(10_000);
  const common = (await runGit(environment, cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)).stdout.trim();
  if (!roots.some(p => pathInEnvironment(p, common))) throw new PluginPackageError('invalid', 'Repository metadata is outside the approved folders.');
  const refs = (await runGit(environment, cwd, ['for-each-ref', '--count=1001', '--sort=-creatordate', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin', 'refs/tags'], signal)).stdout.trim().split('\n').filter(Boolean);
  const origin = await runGit(environment, cwd, ['config', '--get', 'remote.origin.url'], signal, [0, 1]);
  return { branches: [...new Set(refs.filter(r => !r.startsWith('refs/tags/') && !r.endsWith('/HEAD')).map(r => r.replace(/^refs\/(heads|remotes\/origin)\//, '')))],
    tags: refs.filter(r => r.startsWith('refs/tags/')).slice(0, 1000).map(r => r.slice(10)), remotePath: repositoryRemotePath(origin.stdout.trim()), truncated: refs.length > 1000 };
}
