/**
 * Filesystem tool — path resolution + sandbox validation.
 *
 * Regression coverage for the bug where resolution and validation used two
 * DIFFERENT workspace roots. `resolvePath` anchored on the flat
 * `config.workspace.rootPath`; `validatePath` anchored on the per-user
 * `WorkspaceFS` root. For a real (non-system) user the two roots diverge, so
 * EVERY relative-path call resolved to the flat root and then failed
 * validation against the nested per-user root with "Path '…' is outside
 * allowed workspace directories" — even though the path was the legitimate
 * workspace.
 *
 * The fix collapses both onto a single `WorkspaceFS.forAgent(context)`
 * instance whose `.resolve()` does resolution AND validation. These tests
 * drive the real tool handlers end-to-end (no mocks) against an ephemeral
 * `WORKSPACE_PATH`, in both the per-user nested layout (real users) and the
 * flat layout (system jobs).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { AgentContext } from '@/core/types';
import { FilesystemTool } from './index';

// Expose the registered handlers without going through a swarm/registry.
class TestableFilesystemTool extends FilesystemTool {
  handler(name: string) {
    const h = this.tools.get(name);
    if (!h) throw new Error(`no such tool: ${name}`);
    return h;
  }
}

const USER = 'alice-uuid';

/**
 * Build an AgentContext. `role: 'writing'` makes it an autonomous worker so
 * the permission middleware auto-skips (no DB needed); the tool still runs
 * its full resolution/validation logic.
 */
function ctx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    id: 'agent-1',
    sessionId: 'sess-1234567890',
    userId: USER,
    topic: 'writing',
    model: 'test-model',
    role: 'writing',
    status: 'running',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    metadata: {},
    ...overrides,
  } as AgentContext;
}

let dataRoot: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(k: string, v: string | undefined) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

async function reloadConfig() {
  const { resetConfig, loadConfig } = await import('@/config');
  resetConfig();
  loadConfig();
}

/** Per-user nested root WorkspaceFS uses when multiuser is on. */
function perUserRoot(): string {
  return resolve(dataRoot, 'users', USER, 'workspaces', 'default', 'files');
}

async function makeTool(): Promise<TestableFilesystemTool> {
  const tool = new TestableFilesystemTool();
  await tool.initialize();
  return tool;
}

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'octipus-fs-tool-'));
  setEnv('WORKSPACE_PATH', dataRoot);
  setEnv('DOCUMENTS_PATH', join(dataRoot, 'documents'));
});

afterEach(async () => {
  const { resetConfig } = await import('@/config');
  resetConfig();
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) setEnv(k, v);
});

describe('real users — nested per-user root', () => {
  beforeEach(async () => {
    await reloadConfig();
  });

  test('list_directory(".") no longer throws "outside allowed workspace" (the reported bug)', async () => {
    mkdirSync(perUserRoot(), { recursive: true });
    const tool = await makeTool();
    const res = (await tool.handler('list_directory').execute({ path: '.' }, ctx())) as {
      path: string;
      entries: unknown[];
    };
    // Resolves to the per-user root, not the flat workspace root.
    expect(res.path).toBe(perUserRoot());
  });

  test('list_directory(".") resolved against flat root used to be rejected — assert it is now allowed', async () => {
    mkdirSync(perUserRoot(), { recursive: true });
    const tool = await makeTool();
    await expect(
      tool.handler('list_directory').execute({ path: '.' }, ctx()),
    ).resolves.toBeDefined();
  });

  test('fresh per-user workspace: list_directory(".") materializes the root and returns empty (no ENOENT)', async () => {
    // Deliberately do NOT pre-create perUserRoot — nothing seeds it at session
    // setup, so this used to throw ENOENT. workspaceFor now ensureRootSync()s.
    expect(existsSync(perUserRoot())).toBe(false);
    const tool = await makeTool();
    const res = (await tool.handler('list_directory').execute({ path: '.' }, ctx())) as {
      path: string;
      entries: unknown[];
    };
    expect(res.path).toBe(perUserRoot());
    expect(res.entries).toEqual([]);
    expect(existsSync(perUserRoot())).toBe(true);
  });

  test('fresh per-user workspace: read_file of a missing file still ENOENTs (only the root is created)', async () => {
    const tool = await makeTool();
    await expect(
      tool.handler('read_file').execute({ path: 'nope.md' }, ctx()),
    ).rejects.toThrow(/ENOENT|no such file/i);
  });

  test('write_file lands under the per-user root and the file exists', async () => {
    const tool = await makeTool();
    const res = (await tool.handler('write_file').execute(
      { path: 'space-poem.md', content: '# The Infinite Shore\n' },
      ctx(),
    )) as { success: boolean; path: string };

    expect(res.success).toBe(true);
    // Session-folder redirect is on by default, so the file lands somewhere
    // UNDER the per-user root — never under the bare flat root.
    expect(res.path.startsWith(perUserRoot() + sep)).toBe(true);
    expect(existsSync(res.path)).toBe(true);
  });

  test('write then read round-trips through the same sandbox', async () => {
    const tool = await makeTool();
    const body = 'stars and the quiet dark\n';
    const w = (await tool.handler('write_file').execute(
      { path: 'poem.md', content: body },
      ctx(),
    )) as { path: string };

    const r = (await tool.handler('read_file').execute({ path: w.path }, ctx())) as {
      content: string;
    };
    expect(r.content).toBe(body);
  });

  test('parent traversal is rejected with the friendly message', async () => {
    const tool = await makeTool();
    await expect(
      tool.handler('read_file').execute({ path: '../../../../../etc/passwd' }, ctx()),
    ).rejects.toThrow(/outside allowed workspace directories/);
  });

  test('absolute path outside the sandbox is rejected', async () => {
    const tool = await makeTool();
    await expect(
      tool.handler('read_file').execute({ path: '/etc/passwd' }, ctx()),
    ).rejects.toThrow(/outside allowed workspace directories/);
  });

  test('one user cannot reach another user\'s root by traversal', async () => {
    const tool = await makeTool();
    const escape = `../../../bob-uuid/workspaces/default/files/secret.txt`;
    await expect(
      tool.handler('read_file').execute({ path: escape }, ctx()),
    ).rejects.toThrow(/outside allowed workspace directories/);
  });

  test('devMode projectPath: relative writes land in the project and pass the sandbox', async () => {
    // An external project dir, NOT under the workspace root.
    const projectPath = mkdtempSync(join(tmpdir(), 'octipus-project-'));
    const tool = await makeTool();
    const res = (await tool.handler('write_file').execute(
      { path: 'src/app.ts', content: 'export const x = 1\n' },
      ctx({ metadata: { projectPath } }),
    )) as { success: boolean; path: string };

    expect(res.success).toBe(true);
    expect(res.path).toBe(join(projectPath, 'src', 'app.ts'));
    expect(existsSync(res.path)).toBe(true);
  });

  test('without projectPath, a path inside an external project dir is still rejected', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'octipus-other-'));
    const tool = await makeTool();
    await expect(
      tool.handler('read_file').execute({ path: join(projectPath, 'app.ts') }, ctx()),
    ).rejects.toThrow(/outside allowed workspace directories/);
  });
});

describe('system jobs — flat workspace root (no per-user nesting)', () => {
  // Octipus is always multi-user, so real users get a per-user nested root.
  // In-process system jobs (`userId: 'system'`) are the only callers that
  // still resolve against the flat `config.workspace.rootPath`.
  beforeEach(async () => {
    await reloadConfig();
  });

  test('list_directory(".") resolves to the flat workspace root', async () => {
    mkdirSync(dataRoot, { recursive: true });
    const tool = await makeTool();
    const res = (await tool.handler('list_directory').execute({ path: '.' }, ctx({ userId: 'system' }))) as {
      path: string;
    };
    expect(res.path).toBe(resolve(dataRoot));
  });

  test('write_file lands under the flat root', async () => {
    const tool = await makeTool();
    const res = (await tool.handler('write_file').execute(
      { path: 'notes.md', content: 'hi\n' },
      ctx({ userId: 'system' }),
    )) as { path: string };
    expect(res.path.startsWith(resolve(dataRoot) + sep)).toBe(true);
    expect(existsSync(res.path)).toBe(true);
  });

  test('escapes are still rejected in flat mode', async () => {
    const tool = await makeTool();
    await expect(
      tool.handler('read_file').execute({ path: '/etc/passwd' }, ctx({ userId: 'system' })),
    ).rejects.toThrow(/outside allowed workspace directories/);
  });
});
