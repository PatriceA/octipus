import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { AgentContext } from '@/core/types';
import { getExecutionSignal } from '@/core/execution-scope';
import { sessionRepository } from '@/db/repositories/session-repository';
import { WorkspaceFS, isInside } from '@/security/workspace-fs';
import { detectRunner } from '@/security/shell-sandbox';
import { killProcessTree, whichSync } from '@/utils/proc';
import { fetchActiveSkillIdsForTopic } from './discovery';
import { getSkillRegistry } from './registry';
import { resolveSkillResource, skillResourceRoot } from './resources';
import { canActInSession } from '@/core/rooms/access';

/** Assigned scripts get an offline OS sandbox, not the role's general shell capability. */
export async function runSkillScript(
  skillId: string, script: string, args: string[], cwd: string | undefined, context: AgentContext,
): Promise<unknown> {
  const canonical = getSkillRegistry().canonicalId(skillId);
  const assigned = await fetchActiveSkillIdsForTopic(context.role);
  if (!assigned.includes(canonical)) throw new Error('Script execution requires this skill to be assigned to the agent role.');
  const root = await skillResourceRoot(skillId, context.userId);
  const entry = resolveSkillResource(root, script);
  if (!(await stat(entry)).isFile()) throw new Error('Skill script must be a file.');
  const interpreter = ({ '.mjs': 'node', '.cjs': 'node', '.js': 'node', '.py': 'python3' } as Record<string, string>)[extname(entry)];
  if (!interpreter) throw new Error('Only packaged Node.js and Python scripts are supported.');
  const runtime = whichSync(interpreter, { PATH: '/usr/local/bin:/usr/bin:/bin' });
  if (!runtime) throw new Error(`Skill runtime ${interpreter} is not installed.`);
  const session = await sessionRepository.findById(context.sessionId);
  if (!session || !(await canActInSession(session, context.userId, 'requester'))) throw new Error('Session not found.');
  if (session.context?.planMode) throw new Error('Skill script execution is unavailable in plan mode.');
  const workspace = WorkspaceFS.forSession(session);
  await workspace.ensureRoot();
  const workspaceRoot = await realpath(workspace.root);
  const workdir = cwd ? workspace.resolve(cwd) : workspaceRoot;
  // Additional workspace prefixes must not widen this runner's writable mount.
  if (!isInside(workspaceRoot, workdir)) throw new Error('Script cwd must be inside this session workspace.');
  if (isInside(root, workspaceRoot)) throw new Error('The writable workspace must not be inside the skill bundle.');
  const sandbox = detectRunner();
  if (process.platform !== 'linux' || sandbox?.runner !== 'bwrap') {
    throw new Error('Assigned skill scripts require bubblewrap on Linux; no unconfined fallback is allowed.');
  }
  const signal = getExecutionSignal(context);
  if (signal?.aborted) throw new Error('Skill execution cancelled.');
  const scratch = await mkdtemp(join(tmpdir(), 'octipus-skill-'));
  try {
    const sandboxArgs = [
      '--die-with-parent', '--unshare-all', '--new-session', '--clearenv',
      '--ro-bind', '/usr', '/usr', '--ro-bind-try', '/bin', '/bin',
      '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
      '--ro-bind-try', '/etc/fonts', '/etc/fonts', '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache',
      '--bind', scratch, '/tmp', '--proc', '/proc', '--dev', '/dev',
      '--bind', workspaceRoot, workspaceRoot, '--ro-bind', root, root,
      '--chdir', workdir, '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp',
      '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8',
      // Chromium may run inside this outer user/mount/network sandbox.
      '--setenv', 'ARCHIFY_CHROME_NO_SANDBOX', '1',
      '--', runtime, entry, ...args,
    ];
    return await new Promise((resolve, reject) => {
      const child = spawn(sandbox.binary, sandboxArgs, { cwd: workdir, env: {}, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; let timedOut = false;
      const abort = () => killProcessTree(child.pid, child);
      const timer = setTimeout(() => { timedOut = true; abort(); }, 120_000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-64 * 1024); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-64 * 1024); });
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      child.on('error', error => { cleanup(); reject(error); });
      child.on('close', (exitCode, exitSignal) => {
        cleanup();
        resolve({ stdout, stderr, exitCode, signal: exitSignal, timedOut, aborted: signal?.aborted ?? false });
      });
    });
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
