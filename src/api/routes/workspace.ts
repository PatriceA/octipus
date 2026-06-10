import { execSync } from 'child_process';
import { Elysia, t } from 'elysia';
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { apiContext } from '@/api/context';
import { getConfig } from '@/config';
import { coreLogger } from '@/utils/logger';

// System directories that must never be added as workspace paths
const DENIED_PATHS = [
  '/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64',
  '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/usr', '/var',
];

function isPathDenied(resolvedPath: string): boolean {
  // Allow /tmp/assistant-* prefixed paths (used for backend logs, temp files)
  if (resolvedPath.startsWith('/tmp/assistant-')) {
    return false;
  }
  for (const denied of DENIED_PATHS) {
    if (resolvedPath === denied || resolvedPath.startsWith(denied + '/')) {
      return true;
    }
  }
  return false;
}

export const workspaceRoutes = new Elysia({ prefix: '/workspace' })
  .use(apiContext)
  .get('/', async ({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }
    const config = getConfig();
    return {
      rootPath: resolve(config.workspace.rootPath),
      additionalPaths: config.workspace.additionalPaths.map(p => resolve(p)),
    };
  }, { detail: { tags: ['workspace'] } })

  .put('/', async ({ user, body, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }
    // Changing the global workspace root is an operator action — a non-admin
    // must not be able to repoint or expand it on a shared instance.
    if (!user.isAdmin) {
      set.status = 403;
      return { error: 'Admin privileges required' };
    }
    const config = getConfig();
    const userHome = homedir();

    // If rootPath is being changed, validate it
    if (body.rootPath !== undefined) {
      const resolvedRoot = resolve(body.rootPath);

      if (isPathDenied(resolvedRoot)) {
        set.status = 400;
        return { error: `Denied path: ${body.rootPath} — system directories cannot be used as workspace root` };
      }

      if (!resolvedRoot.startsWith(userHome)) {
        set.status = 400;
        return { error: `Invalid path: ${body.rootPath} — workspace root must be under user home (${userHome})` };
      }

      if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
        set.status = 400;
        return { error: `Invalid path: ${body.rootPath} (does not exist or is not a directory)` };
      }
    }

    const workspaceRoot = resolve(body.rootPath ?? config.workspace.rootPath);

    // Validate all additional paths
    if (body.additionalPaths) {
      for (const p of body.additionalPaths) {
        const resolved = resolve(p);

        if (isPathDenied(resolved)) {
          set.status = 400;
          return { error: `Denied path: ${p} — system directories cannot be added as workspace paths` };
        }

        if (!resolved.startsWith(workspaceRoot) && !resolved.startsWith(userHome)) {
          set.status = 400;
          return { error: `Invalid path: ${p} — must be under workspace root (${workspaceRoot}) or user home (${userHome})` };
        }

        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
          set.status = 400;
          return { error: `Invalid path: ${p} (does not exist or is not a directory)` };
        }
      }
    }

    // Persist via settings service so hot-reload picks it up
    const { getSettingsService } = await import('@/config/settings-service');
    const svc = getSettingsService();

    if (body.rootPath !== undefined) {
      await svc.set('workspace.rootPath', body.rootPath, user.id);
    }
    if (body.additionalPaths !== undefined) {
      await svc.set('workspace.additionalPaths', body.additionalPaths, user.id);
    }

    // Re-read config after update
    const updated = getConfig();
    return {
      rootPath: resolve(updated.workspace.rootPath),
      additionalPaths: updated.workspace.additionalPaths.map(p => resolve(p)),
    };
  }, {
    body: t.Object({
      rootPath: t.Optional(t.String()),
      additionalPaths: t.Optional(t.Array(t.String())),
    }),
    detail: { tags: ['workspace'] },
  })

  .post('/validate', async ({ user, body, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }
    // `existsSync`/`statSync` on a caller-supplied absolute path is a host
    // filesystem existence oracle (probe /root/.ssh, other users' homes).
    // Restrict to admins — it only exists to support the admin workspace
    // config UI.
    if (!user.isAdmin) {
      set.status = 403;
      return { error: 'Admin privileges required' };
    }
    const resolved = resolve(body.path);
    const exists = existsSync(resolved);
    let isDirectory = false;
    if (exists) {
      try { isDirectory = statSync(resolved).isDirectory(); } catch (err) { coreLogger.error({ err }, 'silent failure in workspace'); }
    }
    return { path: resolved, exists, isDirectory, valid: exists && isDirectory };
  }, {
    body: t.Object({ path: t.String() }),
    detail: { tags: ['workspace'] },
  })

  .get('/repositories', async ({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }
    const config = getConfig();
    const rootPath = resolve(config.workspace.rootPath);

    if (!existsSync(rootPath)) {
      return { repositories: [] };
    }

    const items = readdirSync(rootPath);
    const repositories = items
      .filter(item => {
        const fullPath = join(rootPath, item);
        try {
          const stats = statSync(fullPath);
          return stats.isDirectory() && !item.startsWith('.');
        } catch {
          return false;
        }
      })
      .map(item => ({
        name: item,
        path: join(rootPath, item),
        isGit: existsSync(join(rootPath, item, '.git')),
      }));

    return { repositories };
  }, { detail: { tags: ['workspace'] } })

  .post('/repositories', async ({ user, body, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Authentication required' };
    }
    // Creates a directory (and optionally `git init`s it) under the global
    // workspace root — an operator action, not per-user data.
    if (!user.isAdmin) {
      set.status = 403;
      return { error: 'Admin privileges required' };
    }
    const config = getConfig();
    const rootPath = resolve(config.workspace.rootPath);

    // Resolve the parent directory the repo lands in. Defaults to the
    // workspace root; an explicit `parentPath` lets the user choose where the
    // repo goes (the QA: "Create new repository doesn't let me choose the
    // parent folder"). The parent must be the workspace root, an additional
    // path, or a directory underneath one of them — never an arbitrary path.
    const allowedRoots = [rootPath, ...config.workspace.additionalPaths.map((p) => resolve(p))];
    let parentPath = rootPath;
    if (body.parentPath) {
      const candidate = resolve(body.parentPath);
      const withinAllowed = allowedRoots.some(
        (r) => candidate === r || candidate.startsWith(r + '/'),
      );
      if (!withinAllowed) {
        set.status = 400;
        return { error: 'Parent folder must be the workspace root or an additional path (or a subfolder of one)' };
      }
      if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
        set.status = 400;
        return { error: 'Parent folder does not exist or is not a directory' };
      }
      parentPath = candidate;
    }

    // Containment: reject names that escape the parent via traversal (`../`),
    // absolute paths, or null bytes. Without this, name="../../x" creates an
    // attacker-chosen directory anywhere the process can write.
    if (body.name.includes('\0') || body.name.includes('/') || body.name.includes('\\')) {
      set.status = 400;
      return { error: 'Invalid repository name: must not contain path separators or null bytes' };
    }
    const repoPath = resolve(parentPath, body.name);
    if (repoPath !== join(parentPath, body.name) || !repoPath.startsWith(parentPath + '/')) {
      set.status = 400;
      return { error: 'Invalid repository name: resolves outside the parent folder' };
    }

    if (existsSync(repoPath)) {
      set.status = 409;
      return { error: 'Directory already exists' };
    }

    try {
      mkdirSync(repoPath, { recursive: true });
      if (body.initGit) {
        execSync('git init', { cwd: repoPath });
      }
      return {
        name: body.name,
        path: repoPath,
        isGit: body.initGit || false,
      };
    } catch (err) {
      set.status = 500;
      return { error: `Failed to create repository: ${(err as Error).message}` };
    }
  }, {
    body: t.Object({
      name: t.String({ minLength: 1 }),
      parentPath: t.Optional(t.String()),
      initGit: t.Optional(t.Boolean()),
    }),
    detail: { tags: ['workspace'] },
  });

