import { execSync } from 'child_process';
import { Elysia, t } from 'elysia';
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { apiContext } from '@/api/context';
import { getConfig } from '@/config';
import { WorkspaceFS } from '@/security/workspace-fs';
import { coreLogger } from '@/utils/logger';

/**
 * The per-user workspace files root for `userId` — the SAME root the
 * filesystem tool sandboxes an agent to (`WorkspaceFS.forAgent`). REST
 * routes that surface or mutate a user's project files must anchor here, not
 * on the flat `config.workspace.rootPath`: under multiuser those differ, so a
 * repo created under the flat root is invisible to (and rejected by) the
 * agent's sandbox — the QA "Path '…/.octipus/workspace' is outside allowed
 * workspace directories" after a repo was created fine on disk.
 *
 * `ensureRootSync` materializes the dir so a first-time user gets an empty
 * list instead of ENOENT.
 */
function userWorkspaceRoot(userId: string): string {
  const fs = WorkspaceFS.forAgent({ userId });
  fs.ensureRootSync();
  return fs.root;
}

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
      // Per-user nested root — the one the agent's filesystem sandbox uses —
      // so "Projects are subfolders of your workspace root" matches what the
      // agent can actually read/write.
      rootPath: userWorkspaceRoot(user.id),
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
    const rootPath = userWorkspaceRoot(user.id);

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
    // Creates a directory (and optionally `git init`s it) under the CALLER'S
    // own per-user workspace root. This is per-user data confined to the
    // user's sandbox (and name-validated below), so it no longer requires
    // admin — every authenticated user may scaffold repos in their own space.
    const config = getConfig();
    const rootPath = userWorkspaceRoot(user.id);

    // Resolve the parent directory the repo lands in. Defaults to the
    // workspace root; an explicit `parentPath` lets the user choose where the
    // repo goes (the QA: "Create new repository doesn't let me choose the
    // parent folder"). The parent must be the workspace root, an additional
    // path, or a directory underneath one of them — never an arbitrary path.
    //
    // `additionalPaths` are GLOBAL operator-configured roots (shared across
    // users), so only admins may target them. A non-admin is confined to their
    // own per-user root — otherwise de-admin-gating this route would let any
    // user scaffold dirs in shared paths they don't own.
    const allowedRoots = [
      rootPath,
      ...(user.isAdmin ? config.workspace.additionalPaths.map((p) => resolve(p)) : []),
    ];
    let parentPath = rootPath;
    if (body.parentPath) {
      if (!existsSync(body.parentPath) || !statSync(body.parentPath).isDirectory()) {
        set.status = 400;
        return { error: 'Parent folder does not exist or is not a directory' };
      }
      // Canonicalise via realpath BEFORE the containment check: resolve() is
      // purely lexical, so a symlink inside an allowed root (e.g. ws/escape ->
      // /etc) would otherwise pass the prefix check and redirect mkdir/git
      // outside the sandbox. Compare the real path instead.
      let candidate: string;
      try {
        candidate = realpathSync(resolve(body.parentPath));
      } catch {
        set.status = 400;
        return { error: 'Parent folder could not be resolved' };
      }
      const withinAllowed = allowedRoots.some(
        (r) => candidate === r || candidate.startsWith(r + '/'),
      );
      if (!withinAllowed || isPathDenied(candidate)) {
        set.status = 400;
        return { error: 'Parent folder must be the workspace root or an additional path (or a subfolder of one)' };
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
    // Dot-only names resolve to the parent itself or its parent; the containment
    // check below already rejects them, but block explicitly so the intent is
    // obvious and a future weakening of that check can't open a hole.
    if (body.name === '.' || body.name === '..') {
      set.status = 400;
      return { error: 'Invalid repository name' };
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

