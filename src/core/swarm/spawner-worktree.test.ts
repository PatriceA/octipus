/**
 * `swarm.worktreeIsolation` through the spawner's real retry path.
 *
 * `singleSpawnAndRun` is the one thing stubbed (it boots an agent and calls a
 * model); everything around it — the qualification check, worktree creation,
 * the reuse across retries, the finish/merge and the report on the result — is
 * the production code, against a real temp git repo.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig, refreshConfigKey, resetConfig } from '@/config';

let projectPath = '';
let backupModelId: string | null = null;
let devMode = true;

vi.mock('@/models/model-registry', async (importOriginal) => {
  if (process.env.INTEGRATION === '1') return await importOriginal<object>();
  return {
    getModelRegistry: () => ({
      getBackupModelForTopic: async () => (backupModelId ? { modelId: backupModelId } : null),
      getModelForTopic: async () => null,
      getModel: async () => null,
      getModelByModelId: async () => null,
      getDefaultModel: async () => null,
    }),
  };
});

vi.mock('@/db/repositories/session-repository', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  if (process.env.INTEGRATION === '1') return real;
  return {
    ...real,
    sessionRepository: {
      findById: async () => ({ context: devMode ? { devMode: true, projectPath } : {} }),
    },
  };
});

// The agent boundary, for the tests that drive the REAL `singleSpawnAndRun`:
// `spawn` records the context metadata the spawner composed for the child and
// then refuses, which ends that attempt as a plain `tool_error`.
const captured = vi.hoisted(() => ({ metadata: [] as Array<Record<string, unknown>> }));
vi.mock('@/core/agent-manager', async (importOriginal) => {
  if (process.env.INTEGRATION === '1') return await importOriginal<object>();
  return {
    getAgentManager: () => ({
      spawn: async (o: { contextMetadata?: Record<string, unknown> }) => {
        captured.metadata.push(o.contextMetadata ?? {});
        throw new Error('spawn captured by test');
      },
      getEvents: () => [],
      stop: () => {},
    }),
  };
});

const { SwarmSpawner } = await import('./spawner');
const { createWorktree, recordAttemptTree, removeWorktree } = await import('./worktree');

/** Drive the real `singleSpawnAndRun` for a child of an agent with `parentMetadata`. */
async function runReal(
  childModel: string,
  parentMetadata: Record<string, unknown>,
  childDepth: 1 | 2 = 2,
): Promise<ChildResult> {
  const spawner = new SwarmSpawner({} as never);
  return (spawner as unknown as { runChildWithRetry: (o: unknown) => Promise<ChildResult> }).runChildWithRetry({
    parent: { id: 'agent-1', rootSessionId: 's1', signal: new AbortController().signal },
    parentContext: { userId: 'u1', sessionId: 's1', metadata: parentMetadata },
    childDepth,
    childKind: childDepth === 2 ? 'subagent' : 'agent',
    childRole: 'coding',
    childModel,
    childLane: 'coding',
    childTools: [],
    budget: {
      tokens: { cap: 80_000, used: 0 },
      wallClockMs: { cap: 600_000, startedAt: Date.now() },
      fanOut: { cap: 0, used: 0 },
      depth: childDepth,
    },
    topicPath: 'coding/sub',
    subtopic: 'x',
    brief: { taskBrief: 'edit', topicPath: 'coding/sub', originalUserRequest: 'r', plan: [{ action: 'edit' }] },
    briefHash: 'h2',
    childMessage: 'TASK',
    reason: 'normal',
    spawnMode: 'await',
  });
}
type ChildResult = import('./types').ChildResult;
type Handle = import('./worktree').WorktreeHandle;

const inIntegration = process.env.INTEGRATION === '1';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function ok(over: Partial<ChildResult> = {}): ChildResult {
  return {
    nodeId: 'n1',
    kind: 'agent',
    status: 'ok',
    output: 'done',
    usedTokens: 10,
    durationMs: 1,
    spawnedChildren: [],
    receipt: {
      schemaVersion: 1,
      nodeId: 'n1',
      kind: 'agent',
      status: 'ok',
      sideEffects: {
        toolCalls: 0, filesChanged: 0, commandsRun: 0, approvalsRequired: 0, approvalsDenied: 0,
        autoApproved: 0, permissionDenials: 0, toolErrors: 0, byName: {},
      },
      tokens: { used: 10, cap: 1000 },
      durationMs: 1,
      unavailable: [],
      notCertified: ['correctness', 'security'],
    },
    ...over,
  } as ChildResult;
}

type AttemptOpts = { worktree?: Handle | null; childModel: string };
type Step = (
  wt: Handle | null | undefined,
  o: AttemptOpts,
  spawner: InstanceType<typeof SwarmSpawner>,
) => ChildResult | Promise<ChildResult>;

/**
 * Run `runChildWithRetry` with a scripted child; each attempt may write into
 * its tree. Mirrors the real `singleSpawnAndRun` contract: only a CLI attempt
 * runs in the worktree, and its result is recorded as coming from it.
 */
async function run(
  childRole: string,
  childModel: string,
  attempts: Step[],
): Promise<{ final: ChildResult; seen: Array<Handle | null | undefined>; models: string[] }> {
  const spawner = new SwarmSpawner({} as never);
  const seen: Array<Handle | null | undefined> = [];
  const models: string[] = [];
  let i = 0;
  (spawner as unknown as { singleSpawnAndRun: unknown }).singleSpawnAndRun = async (o: AttemptOpts) => {
    seen.push(o.worktree);
    models.push(o.childModel);
    const step = attempts[Math.min(i, attempts.length - 1)] as Step;
    i++;
    const inTree = o.worktree && o.childModel.startsWith('cli/') ? o.worktree : undefined;
    const r = await step(inTree, o, spawner);
    if (inTree) recordAttemptTree(r, inTree.path);
    return r;
  };
  const final = await (
    spawner as unknown as { runChildWithRetry: (o: unknown) => Promise<ChildResult> }
  ).runChildWithRetry({
    parent: { id: 'parent-1', rootSessionId: 's1' },
    parentContext: { userId: 'u1', sessionId: 's1' },
    childDepth: 1,
    childKind: 'agent',
    childRole,
    childModel,
    childLane: 'coding',
    childTools: [],
    budget: {
      tokens: { cap: 80_000, used: 0 },
      wallClockMs: { cap: 600_000, startedAt: Date.now() },
      fanOut: { cap: 4, used: 0 },
      depth: 1,
    },
    topicPath: 'coding',
    subtopic: 'x',
    brief: { taskBrief: 'add feature.ts', topicPath: 'coding' },
    briefHash: 'h1',
    childMessage: 'TASK',
    reason: 'normal',
    spawnMode: 'await',
  });
  return { final, seen, models };
}

describe.skipIf(inIntegration)('SwarmSpawner — worktree isolation', () => {
  let base: string;
  const prevRoot = process.env.OCTIPUS_WORKTREES_DIR;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'octipus-spawn-wt-')));
    projectPath = join(base, 'repo');
    mkdirSync(projectPath);
    process.env.OCTIPUS_WORKTREES_DIR = join(base, 'worktrees');
    git(projectPath, 'init', '-q', '-b', 'main');
    writeFileSync(join(projectPath, 'README.md'), 'hi\n');
    git(projectPath, 'add', '-A');
    git(projectPath, '-c', 'user.name=T', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    backupModelId = null;
    devMode = true;
    resetConfig();
    getConfig();
  });

  afterEach(() => {
    resetConfig();
    if (prevRoot === undefined) delete process.env.OCTIPUS_WORKTREES_DIR;
    else process.env.OCTIPUS_WORKTREES_DIR = prevRoot;
    rmSync(base, { recursive: true, force: true });
  });

  it('flag off (the default): no worktree, the child shares the tree', async () => {
    expect(getConfig().swarm.worktreeIsolation).toBe(false);
    const { final, seen } = await run('coding', 'cli/claude-code', [() => ok()]);
    expect(seen).toEqual([null]);
    expect(final.worktree).toBeUndefined();
    expect(existsSync(join(base, 'worktrees'))).toBe(false);
  });

  it('flag on + coding CLI child: own worktree, merged back, reported on result and receipt', async () => {
    refreshConfigKey('swarm.worktreeIsolation', true);
    const { final, seen } = await run('coding', 'cli/claude-code', [
      (wt) => {
        writeFileSync(join(wt!.path, 'feature.ts'), 'export const f = 1;\n');
        return ok();
      },
    ]);
    const wt = seen[0]!;
    expect(wt.path.startsWith(join(base, 'worktrees'))).toBe(true);
    expect(wt.branch).toMatch(/^octipus\/c[0-9a-f]{20}$/);
    expect(final.worktree).toMatchObject({ branch: wt.branch, merge: 'merged', filesChanged: 1 });
    expect(final.receipt?.worktree?.merge).toBe('merged');
    expect(readFileSync(join(projectPath, 'feature.ts'), 'utf-8')).toContain('f = 1');
    // Cleaned up: directory gone, merged branch deleted.
    expect(existsSync(wt.path)).toBe(false);
    expect(git(projectPath, 'branch', '--list', wt.branch).trim()).toBe('');
  });

  it('a crash retry reuses the same worktree, so the first attempt’s work is kept', async () => {
    refreshConfigKey('swarm.worktreeIsolation', true);
    const { final, seen } = await run('coding', 'cli/claude-code', [
      (wt) => {
        writeFileSync(join(wt!.path, 'part1.txt'), '1\n');
        return ok({ status: 'tool_error', notes: 'crash' });
      },
      (wt) => {
        writeFileSync(join(wt!.path, 'part2.txt'), '2\n');
        return ok();
      },
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
    expect(final.worktree?.filesChanged).toBe(2);
    expect(existsSync(join(projectPath, 'part1.txt'))).toBe(true);
    expect(existsSync(join(projectPath, 'part2.txt'))).toBe(true);
  });

  it('a failed child is not merged; its work stays on the branch', async () => {
    refreshConfigKey('swarm.worktreeIsolation', true);
    const { final, seen } = await run('coding', 'cli/claude-code', [
      (wt) => {
        writeFileSync(join(wt!.path, 'wip.txt'), 'w\n');
        return ok({ status: 'timeout' });
      },
    ]);
    expect(final.worktree?.merge).toBe('skipped_status');
    expect(final.notes).toMatch(/NOT merged/);
    expect(existsSync(join(projectPath, 'wip.txt'))).toBe(false);
    expect(git(projectPath, 'show', `${seen[0]!.branch}:wip.txt`)).toBe('w\n');
  });

  it('flag on but not a coding CLI child: no worktree', async () => {
    refreshConfigKey('swarm.worktreeIsolation', true);
    expect((await run('research', 'cli/claude-code', [() => ok()])).seen).toEqual([null]);
    expect((await run('coding', 'gpt-native-model', [() => ok()])).seen).toEqual([null]);
  });

  it('falls back to the shared tree when the worktree cannot be created', async () => {
    refreshConfigKey('swarm.worktreeIsolation', true);
    // The worktrees root is a FILE: `createWorktree` throws, the child still runs.
    writeFileSync(join(base, 'worktrees'), 'not a directory');
    const broken = await run('coding', 'cli/claude-code', [() => ok()]);
    expect(broken.seen).toEqual([null]);
    expect(broken.final.status).toBe('ok');
    expect(broken.final.worktree).toBeUndefined();
  });

  it('falls back to the shared tree when the project is not a git repository', async () => {
    refreshConfigKey('swarm.worktreeIsolation', true);
    // Not a git repository any more: creation fails, the child still runs.
    rmSync(join(projectPath, '.git'), { recursive: true, force: true });
    const { final, seen } = await run('coding', 'cli/claude-code', [() => ok()]);
    expect(seen).toEqual([null]);
    expect(final.status).toBe('ok');
    expect(final.worktree).toBeUndefined();
  });

  it('isolates dev-mode projects only, never the per-user sandbox', async () => {
    refreshConfigKey('swarm.worktreeIsolation', true);
    devMode = false;
    const { seen } = await run('coding', 'cli/claude-code', [() => ok()]);
    expect(seen).toEqual([null]);
  });

  it('does not isolate when the project has uncommitted tracked changes the worktree would not see', async () => {
    refreshConfigKey('swarm.worktreeIsolation', true);
    writeFileSync(join(projectPath, 'README.md'), 'user edit in progress\n');
    const { final, seen } = await run('coding', 'cli/claude-code', [() => ok()]);
    expect(seen).toEqual([null]);
    expect(final.worktree).toBeUndefined();
    expect(readFileSync(join(projectPath, 'README.md'), 'utf-8')).toBe('user edit in progress\n');
    expect(existsSync(join(base, 'worktrees'))).toBe(false);
  });

  it('does not merge the worktree when the ok answer came from a native backup on the shared tree', async () => {
    refreshConfigKey('swarm.worktreeIsolation', true);
    backupModelId = 'native-backup';
    const { final, seen, models } = await run('coding', 'cli/claude-code', [
      (wt) => {
        writeFileSync(join(wt!.path, 'half-done.ts'), 'partial\n');
        return ok({ status: 'provider_error', notes: 'rate limited' });
      },
      () => ok(),
    ]);
    expect(models).toEqual(['cli/claude-code', 'native-backup']);
    expect(final.status).toBe('ok');
    expect(final.worktree?.merge).toBe('skipped_other_attempt');
    expect(final.worktree?.branchKept).toBe(true);
    expect(existsSync(join(projectPath, 'half-done.ts'))).toBe(false);
    expect(git(projectPath, 'show', `${seen[0]!.branch}:half-done.ts`)).toBe('partial\n');
  });

  it('a contract retry after a native backup reuses that root’s first baseline', async () => {
    refreshConfigKey('swarm.worktreeIsolation', true);
    backupModelId = 'native-backup';
    type Snap = unknown;
    const baselineFor = (s: unknown, o: unknown, root: string): Promise<Snap> =>
      (s as { baselineFor: (o: unknown, r: string) => Promise<Snap> }).baselineFor(o, root);
    const taken: Array<{ root: string; snap: Snap }> = [];
    const gateFailed = ok({
      status: 'contract_failed',
      scorerOutcome: { passed: false, ran: 1, failures: [{ scorer: 'file_exists', reason: 'file "x.ts" does not exist' }] },
      notes: 'Scorer gate failed',
    });
    const { final, models } = await run('coding', 'cli/claude-code', [
      async (wt, o, s) => {
        taken.push({ root: wt!.path, snap: await baselineFor(s, o, wt!.path) });
        writeFileSync(join(wt!.path, 'a.ts'), 'a\n');
        return ok({ status: 'provider_error' });
      },
      async (_wt, o, s) => {
        taken.push({ root: projectPath, snap: await baselineFor(s, o, projectPath) });
        // The backup's own work on the shared tree: a re-snapshot would hide it.
        writeFileSync(join(projectPath, 'b.ts'), 'b\n');
        return gateFailed;
      },
      async (_wt, o, s) => {
        taken.push({ root: projectPath, snap: await baselineFor(s, o, projectPath) });
        return ok();
      },
    ]);
    expect(models).toEqual(['cli/claude-code', 'native-backup', 'native-backup']);
    expect(final.status).toBe('ok');
    expect(taken).toHaveLength(3);
    expect(taken[1]!.snap).not.toBe(taken[0]!.snap);
    // Same object: taken once for the project, before the backup wrote b.ts.
    expect(taken[2]!.snap).toBe(taken[1]!.snap);
    expect(final.worktree?.merge).toBe('skipped_other_attempt');
  });

  describe('descendants of a worktree child (real singleSpawnAndRun)', () => {
    const worktreeDirs = () =>
      readdirSync(join(base, 'worktrees'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

    beforeEach(() => {
      captured.metadata.length = 0;
      refreshConfigKey('swarm.worktreeIsolation', true);
    });

    it('a CLI grandchild inherits the worktree as its cwd and gets no worktree of its own', async () => {
      const parentTree = await createWorktree(projectPath, 'cparent1');
      const result = await runReal('cli/claude-code', { worktreePath: parentTree.path });

      expect(captured.metadata.length).toBeGreaterThan(0);
      for (const md of captured.metadata) {
        expect(md.worktreePath).toBe(parentTree.path);
        expect(md.projectPath).toBeUndefined();
      }
      expect(worktreeDirs()).toEqual(['cparent1']);
      expect(result.worktree).toBeUndefined();
      await removeWorktree(parentTree, { merged: true });
    });

    it('a native grandchild is routed into the worktree through projectPath', async () => {
      const parentTree = await createWorktree(projectPath, 'cparent2');
      await runReal('native-model', { worktreePath: parentTree.path });

      expect(captured.metadata.length).toBeGreaterThan(0);
      for (const md of captured.metadata) {
        expect(md.worktreePath).toBe(parentTree.path);
        // The native file/shell tools resolve against this, not the session's project.
        expect(md.projectPath).toBe(parentTree.path);
      }
      expect(worktreeDirs()).toEqual(['cparent2']);
      await removeWorktree(parentTree, { merged: true });
    });

    it('a forged worktreePath outside the worktrees root is not inherited', async () => {
      await runReal('native-model', { worktreePath: projectPath });
      for (const md of captured.metadata) {
        expect(md.worktreePath).toBeUndefined();
        expect(md.projectPath).toBeUndefined();
      }
    });

    it('a top-level coding CLI child gets its own worktree, reused by its crash retry', async () => {
      const result = await runReal('cli/claude-code', {}, 1);
      const paths = captured.metadata.map((m) => m.worktreePath);
      expect(paths.length).toBe(2);
      expect(paths[0]).toMatch(new RegExp(`^${join(base, 'worktrees')}/c[0-9a-f]{20}$`));
      expect(paths[1]).toBe(paths[0]);
      // Nothing was done: settled as no_changes and cleaned up.
      expect(result.worktree?.merge).toBe('no_changes');
      expect(worktreeDirs()).toEqual([]);
    });
  });
});
