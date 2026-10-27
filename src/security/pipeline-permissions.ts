import { isUuid } from '@/db/repositories/scoped';
import { isAbsolute, resolve } from 'node:path';
import { pipelinePermissionProfileSchema, type PipelinePermissionProfile } from '@/shared/pipeline-permissions';
import { pipelineRepository } from '@/db/repositories/pipeline-repository';
import type { ApprovalCaller } from './approval-route';
import type { SpaceToolCall } from './space-tools';
import { callFingerprint, routedToolName } from './approved-calls';
import { matchDestructiveCommand } from '@/tools/shell/policy';

/** Match only explicit shell forms; shell expressions and arbitrary inline scripts ask separately. */
export function profileAllows(profile: PipelinePermissionProfile, call: SpaceToolCall): boolean {
  if (!(call.toolId === 'shell' && ['execute', 'execute_elevated'].includes(call.action) || call.toolId === 'cli-native:Bash' && call.action === 'Bash')) return false;
  const args = call.args ?? {};
  const command = args.command;
  if (typeof command !== 'string' || Object.keys(args).some(key => !['command', 'cwd', 'timeout', 'description', 'network', 'useShell'].includes(key))) return false;
  // The shell and vendor CLIs can default to different workspaces/worktrees.
  // A profile is authority for a named repo, never evidence of execution cwd.
  if (typeof args.cwd !== 'string' || !isAbsolute(args.cwd)) return false;
  const cwd = resolve(args.cwd);
  if (![profile.repoPath, ...profile.repoPaths].some(repo => cwd === resolve(repo)) || matchDestructiveCommand(command)) return false;
  if (profile.commands.includes(command)) return true;
  if (/[;&|`$\n<>\\]/.test(command.replace(/'[^']*'|"[^"]*"/g, '')) || /[$`]/.test(command)) return false;
  const words = command.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map(word => word.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
  if (words.some(word => /^(?:-C|--(?:prefix|cwd|dir|directory|project-directory|env-file|file)(?:=|$))/.test(word))) return false;
  const elevated = call.action === 'execute_elevated';
  if (!elevated && profile.packageManagers.includes(words[0] as 'npm') && /^(install|add|ci|test|build|version|--version|mod|list|env|vet)$/.test(words[1] ?? '')) return true;
  if (!elevated && profile.packageManagers.includes(words[0] as 'npm') && words[1] === 'run' && /^(?:test|build|lint|typecheck|check)(?::[a-z0-9_-]+)?$/i.test(words[2] ?? '')) return true;
  if (words[0] === 'docker' && words[1] === 'compose' && ['-p', '--project-name'].includes(words[2])
    && profile.dockerProjects.includes(words[3]) && ['build', 'up', 'ps', 'logs', 'config', 'version'].includes(words[4])) {
    return words.slice(5).every(word => /^[a-z0-9][a-z0-9_.-]*$/i.test(word) || /^(?:-d|--detach|--no-cache|--pull|--build|--no-deps|--quiet|--no-log-prefix|--tail=\d+)$/.test(word));
  }
  if (elevated || words[0] !== 'curl') return false;
  let urls = 0;
  for (let i = 1; i < words.length; i++) {
    const word = words[i].replace(/^(['"])(.*)\1$/, '$2');
    if (/^-[sSfIL]+$/.test(word) || ['--head', '--silent', '--show-error', '--fail', '--location'].includes(word)) continue;
    if (['-X', '--request'].includes(word)) { if (!['GET', 'HEAD'].includes(words[++i])) return false; continue; }
    try {
      const url = new URL(word);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !profile.publicHosts.includes(url.hostname)) return false;
      urls++;
    } catch { return false; }
  }
  return urls > 0;
}

export async function runPermissionProfile(caller: ApprovalCaller) {
  const id = caller.metadata?.pipelineId;
  if (typeof id !== 'string' || !isUuid(id) || caller.root === true || typeof caller.metadata?.attemptId !== 'string') return undefined;
  const pipeline = await pipelineRepository.findById(id);
  if (!pipeline || pipeline.userId !== caller.userId || pipeline.sessionId !== caller.sessionId
    || (pipeline.workspaceId ?? null) !== (caller.workspaceId ?? null)
    || !['running', 'awaiting_approval'].includes(pipeline.status)) return undefined;
  const stored = pipeline.metadata?.permissionProfile as { approvedBy?: string; repoPath?: string; profile?: unknown } | undefined;
  const parsed = pipelinePermissionProfileSchema.safeParse(stored?.profile);
  return stored?.approvedBy === caller.userId && parsed.success && stored.repoPath === parsed.data.repoPath ? { pipeline, profile: parsed.data } : undefined;
}

/** Save the actual authorized arguments, never an agent-authored pattern. */
export async function rememberRunDecision(caller: ApprovalCaller, call: SpaceToolCall): Promise<void> {
  const run = await runPermissionProfile(caller);
  if (!run?.profile.rememberDecisions || !call.args) return;
  const name = routedToolName(call.toolId, call.action, call.toolName);
  if (!name) return;
  await pipelineRepository.appendRunMetadata(run.pipeline.id, 'approvedCalls', {
    toolId: call.toolId, toolName: name, action: call.action, fingerprint: callFingerprint(call.toolId, call.action, name, call.args),
    nodeKey: '*', hostServices: caller.metadata?.hostServices === true,
  });
}
