import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { getConfig, refreshConfigKey, resetConfig } from '@/config';
import { ToolNotExecutedError } from '@/core/tool-execution-error';
import type { AgentContext } from '@/core/types';
import { WorkspaceFS } from '@/security/workspace-fs';
import { ShellTool } from './index';

// `shell__run` used to default to the FLAT `config.workspace.rootPath` while
// every `filesystem__*` call was sandboxed to the per-user nested root two
// levels below it. Measured cost, 2026-08-07: an Implementation stage made 27
// tool calls, ran 13 commands and committed, and the evidence gate recorded
// `filesChanged: 0, filesTouched: 0` — the work had gone somewhere the
// workspace snapshot does not look, so the stage was failed for doing nothing.
const USER = '11111111-2222-3333-4444-555555555555';

function agentCtx(metadata: Record<string, unknown> = {}): AgentContext {
  const now = new Date();
  return { space: null, trigger: 'user', funding: 'own', 
    id: 'a1', sessionId: 's1', userId: USER, workspaceId: null, topic: 'general', model: '', role: 'general',
    status: 'running', createdAt: now, updatedAt: now, metadata,
  };
}

// A workspace root this suite owns (`getConfig()` first: `refreshConfigKey`
// is a no-op with no config loaded).
beforeAll(() => {
  getConfig();
  refreshConfigKey('workspace.rootPath', mkdtempSync(join(tmpdir(), 'octi-shell-ws-')));
});
afterAll(() => resetConfig());

const shell = new ShellTool() as unknown as {
  getWorkspaceRoot(c: AgentContext): string;
  resolveCwd(cwd: unknown, c: AgentContext | undefined): string;
};

describe('shell default cwd', () => {
  test('is the same root the filesystem sandbox enforces for the agent', () => {
    expect(shell.getWorkspaceRoot(agentCtx())).toBe(WorkspaceFS.forAgent(agentCtx()).root);
  });

  test("is the dev-mode project when the agent has one", () => {
    const project = mkdtempSync(join(tmpdir(), 'octi-shell-project-'));
    expect(shell.resolveCwd(undefined, agentCtx({ projectPath: project }))).toBe(project);
  });

  test('refuses to run without an agent context rather than pick a shared root', () => {
    expect(() => shell.resolveCwd(undefined, undefined)).toThrow(ToolNotExecutedError);
  });
});

describe('shell named cwd — inside the workspace, an allowed extra, or the project', () => {
  test('a cwd inside the workspace root is accepted; a relative one is taken from it', () => {
    const fs = WorkspaceFS.forAgent(agentCtx());
    mkdirSync(join(fs.root, 'sub'), { recursive: true });
    const root = realpathSync(fs.root);
    expect(shell.resolveCwd(join(fs.root, 'sub'), agentCtx())).toBe(join(root, 'sub'));
    expect(shell.resolveCwd('sub', agentCtx())).toBe(join(root, 'sub'));
  });

  test('a cwd outside the workspace root is refused before the command runs', () => {
    expect(() => shell.resolveCwd('/etc', agentCtx())).toThrow(ToolNotExecutedError);
    expect(() => shell.resolveCwd('../../..', agentCtx())).toThrow(/outside the workspace/);
  });

  test('a cwd inside the dev-mode project is accepted', () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'octi-shell-project-')));
    mkdirSync(join(project, 'pkg'));
    expect(shell.resolveCwd(join(project, 'pkg'), agentCtx({ projectPath: project }))).toBe(join(project, 'pkg'));
    expect(shell.resolveCwd('pkg', agentCtx({ projectPath: project }))).toBe(join(project, 'pkg'));
  });

  test('the transient-file prefix stays an allowed extra', () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'assistant-shell-')));
    expect(shell.resolveCwd(tmp, agentCtx())).toBe(tmp);
  });
});
