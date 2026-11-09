import { resolveEnvironmentCwd } from './environment-runtime';
import { isAbsolute, resolve } from 'node:path';
import type { AgentContext } from '@/core/types';
import { ToolNotExecutedError } from '@/core/tool-execution-error';
import { WorkspaceFS, WorkspaceFsError } from './workspace-fs';

/** Shared execution and approval cwd resolution; never infer cwd from a grant. */
export function resolveShellCwd(requested: unknown, context: AgentContext | undefined): string {
  if (!context) {
    throw new ToolNotExecutedError('shell', 'shell commands run for an agent: no agent context was given');
  }
  const selected = resolveEnvironmentCwd(requested, context);
  if (selected) return selected;
  const fs = WorkspaceFS.forAgent(context);
  const project = !fs.isSpace && typeof context.metadata?.projectPath === 'string' && context.metadata.projectPath ? resolve(context.metadata.projectPath) : undefined;
  const base = project ?? fs.root;
  if (requested !== undefined && requested !== null && typeof requested !== 'string') {
    throw new ToolNotExecutedError('shell', 'cwd must be a string');
  }
  try {
    return fs.resolve(requested ? (isAbsolute(requested) ? requested : resolve(base, requested)) : base);
  } catch (err) {
    if (err instanceof WorkspaceFsError) {
      throw new ToolNotExecutedError('shell', `cwd '${requested}' is outside the workspace; run the command from the workspace or the project`);
    }
    throw err;
  }
}
