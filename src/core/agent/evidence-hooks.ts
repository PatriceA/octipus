/**
 * Project evidence hooks: commands an operator declared for a project folder
 * (`agent.evidenceHooks` — test, build, lint, typecheck) that a pipeline runs
 * before it accepts a deliverable. Their exit codes are completion evidence the
 * model cannot talk its way around: a failing hook sends the work back to the
 * stage that produced it, and a run whose hooks still fail after
 * `EVIDENCE_REPAIR_LIMIT` repairs ends failed, never completed.
 *
 * Runs through the `command_exit_zero` gate (`swarm/scorers.ts`), the path a
 * stage's `verifyCommand` already uses: argv only, the shell tool's content
 * policy, the operator's `shell.execute` permission, the same process sandbox,
 * a workspace-resolved cwd and a hard timeout, with output kept to its last
 * ~2000 characters. There is no second command runner here.
 *
 * The command string comes from configuration alone. Nothing a stage wrote is
 * substituted into it, and which hooks run is decided by the folder the
 * stage's commands run in, resolved from the session, never from model text.
 */
import { getConfig } from '@/config';
import type { AgentContext } from '@/core/types';
import type { ScorerContext } from '@/core/swarm/scorers';
import { pathInEnvironment } from '@/security/execution-environments';
import { type EvidenceHook, type EvidenceHookResult, evidenceHooksSchema } from '@/shared/evidence-hooks';
import { coreLogger } from '@/utils/logger';
import type { QAValidationResult } from './types';

export type { EvidenceHook, EvidenceHookResult } from '@/shared/evidence-hooks';

/**
 * How many times one plan item (or a run without a plan loop) may go back to
 * its working stage because a hook failed, before the run stops as failed.
 *
 * Its own bound, like `VERDICT_REPAIR_LIMIT`, rather than the auditor's
 * `qa_fail` edge budget: that budget ends in a human being asked whether to
 * continue despite the failure, and a failing build is not something a pass
 * can be granted over. Each repair is a full trip through the working stages,
 * so the bound is small.
 */
export const EVIDENCE_REPAIR_LIMIT = 2;

/** Which stage is asking, and in what scope its commands run. */
export interface StageCommandCaller {
  userId?: string;
  sessionId: string;
  workspaceId?: string | null;
  space?: AgentContext['space'];
  role: string;
  hostServices?: boolean;
}

/**
 * Where a stage's commands run and with what authority, resolved from the
 * session the way the stage's own shell resolves it: the session's workspace,
 * or its dev-mode project — never a project in a space, whose agents work in
 * the space's files.
 *
 * `root` is the directory the commands run in when it can be known here; it is
 * what decides which project's hooks apply. `refused` is set when the stage
 * may not run commands in this scope at all.
 */
export async function stageCommandScope(caller: StageCommandCaller): Promise<{ root: string | null; scorer: ScorerContext; refused?: string }> {
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  const session = await sessionRepository.findById(caller.sessionId);
  if (!session) throw new Error(`session ${caller.sessionId} not found`);
  const sessionCtx = session.context as { devMode?: boolean; projectPath?: string; executionEnvironmentId?: string } | undefined;
  const { turnWorkspaceId } = await import('./session-resolver');
  const { isSharedWorkspaceId, WorkspaceFS } = await import('@/security/workspace-fs');
  const workspaceId = await turnWorkspaceId(session.userId, session.workspaceId);
  const inSpace = !!caller.space || await isSharedWorkspaceId(workspaceId);
  const projectPath = !inSpace && sessionCtx?.devMode === true ? sessionCtx.projectPath : undefined;
  // A stage naming a space without its scope is refused outright: never run
  // as personal. Its workspace cannot be resolved either (the resolver
  // refuses a space session opened without the space), so it is not asked.
  const refused = inSpace && !caller.space ? 'The stage runs in a space but carries no space scope, so the command was refused.' : undefined;
  const workspaceRoot = refused || sessionCtx?.executionEnvironmentId ? undefined : WorkspaceFS.forSession({ ...session, workspaceId }, { space: caller.space ?? null }).root;
  const scorer: ScorerContext = {
    userId: caller.userId,
    role: caller.role,
    canRunCommands: true,
    // The stage's session, workspace and space: the space role cap and I6
    // apply to these commands as to the stage's own shell.
    sessionId: caller.sessionId,
    workspaceId: caller.workspaceId ?? workspaceId,
    space: caller.space ?? null,
    projectPath,
    executionEnvironmentId: sessionCtx?.executionEnvironmentId,
    hostServices: caller.hostServices,
    workspaceRoot,
  };
  // An execution environment resolves its cwd at run time; outside dev mode
  // there is no folder to match a hook against, so none applies.
  const root = projectPath ?? (sessionCtx?.executionEnvironmentId ? sessionCtx.projectPath ?? null : workspaceRoot ?? null);
  return { root, scorer, refused };
}

/** The configured hooks, validated. A malformed setting fails loud rather than running nothing. */
export function configuredEvidenceHooks(): EvidenceHook[] {
  return evidenceHooksSchema.parse(getConfig().agent.evidenceHooks ?? []);
}

/** The hooks that belong to the project a stage works in: its folder is the hook's root or inside it. */
export function evidenceHooksFor(hooks: EvidenceHook[], root: string | null): EvidenceHook[] {
  if (!root) return [];
  return hooks.filter(hook => pathInEnvironment(hook.root, root));
}

/** `formatCommandOutput`'s text without its sentence-joining prefix. */
function excerpt(formatted: string): string {
  if (formatted === ' with no output') return '';
  return formatted.replace(/^:\n/, '');
}

/** Run one hook through the verification gate and report what happened. Never throws. */
export async function runEvidenceHook(hook: EvidenceHook, scorer: ScorerContext, signal?: AbortSignal): Promise<EvidenceHookResult> {
  const base = { name: hook.name, command: hook.command };
  const { commandScorerShapeError, formatCommandOutput, runScorers } = await import('@/core/swarm/scorers');
  // A hook is an argv, like every verification command. One with shell
  // syntax or a builtin head can never run, and sending a working stage back
  // to repair the operator's configuration would spend a repair on nothing.
  const shape = commandScorerShapeError(hook.command);
  if (shape) {
    return { ...base, passed: false, exitCode: null, durationMs: 0, timedOut: false, outputExcerpt: '', refused: true,
      reason: `evidence hook "${hook.name}" is misconfigured: its command ${shape}` };
  }
  let observed: { exitCode: number | null; timedOut: boolean; signal?: string | null; stdout: string; stderr: string } | undefined;
  const started = Date.now();
  try {
    const outcome = await runScorers(
      [{ kind: 'command_exit_zero', command: hook.command, timeoutMs: hook.timeoutMs }],
      { output: '', notes: '' },
      { ...scorer, canRunCommands: true, ...(signal ? { signal } : {}), onCommandResult: (result) => { observed = result; } },
    );
    const durationMs = Date.now() - started;
    const outputExcerpt = observed ? excerpt(formatCommandOutput(observed.stdout, observed.stderr)) : '';
    const run = { exitCode: observed?.exitCode ?? null, durationMs, timedOut: observed?.timedOut === true, outputExcerpt };
    if (outcome.notEvaluated) return { ...base, ...run, passed: false, refused: true, reason: `not run: ${outcome.notEvaluated}` };
    const failure = outcome.failures[0];
    if (failure) {
      return { ...base, ...run, passed: false, reason: failure.reason, ...(failure.retryable === false ? { refused: true } : {}) };
    }
    // A command that hit its deadline is a failed check even if it managed an
    // exit 0 on the way down.
    if (run.timedOut) return { ...base, ...run, passed: false, reason: `timed out after ${hook.timeoutMs}ms` };
    return { ...base, ...run, passed: true };
  } catch (err) {
    coreLogger.warn({ err: (err as Error).message, hook: hook.name }, 'Evidence hook could not be run');
    return { ...base, passed: false, exitCode: null, durationMs: Date.now() - started, timedOut: false, outputExcerpt: '', refused: true,
      reason: `could not be run: ${(err as Error).message}` };
  }
}

/**
 * Run every hook that applies to the stage's project, in configured order.
 *
 * Returns an empty list when none applies, which callers read as "no evidence
 * hooks here" and carry on exactly as before. Every applicable hook runs even
 * after one fails, so the stage sent back to repair sees all of what is broken
 * at once rather than one failure per round trip.
 */
export async function runEvidenceHooks(
  caller: StageCommandCaller,
  options: { hooks?: EvidenceHook[]; signal?: AbortSignal } = {},
): Promise<EvidenceHookResult[]> {
  const configured = options.hooks ?? configuredEvidenceHooks();
  if (configured.length === 0) return [];
  const scope = await stageCommandScope(caller);
  // Without a resolvable scope there is no telling which project's hooks
  // apply, so every configured one is reported as refused: the run stops for
  // the operator rather than skipping checks that may have been owed.
  const hooks = scope.refused ? configured : evidenceHooksFor(configured, scope.root);
  if (hooks.length === 0) {
    if (!scope.root) coreLogger.warn({ sessionId: caller.sessionId }, 'Evidence hooks are configured but this stage has no project folder to match them against');
    return [];
  }
  const results: EvidenceHookResult[] = [];
  for (const hook of hooks) {
    if (scope.refused) {
      results.push({ name: hook.name, command: hook.command, passed: false, exitCode: null, durationMs: 0, timedOut: false, outputExcerpt: '', refused: true, reason: scope.refused });
      continue;
    }
    if (options.signal?.aborted) break;
    results.push(await runEvidenceHook(hook, scope.scorer, options.signal));
  }
  return results;
}

/** How a hook ended, in a few words. Output is appended separately where it helps. */
export function describeRun(result: EvidenceHookResult): string {
  if (result.passed) return `exit 0 in ${result.durationMs}ms`;
  if (result.timedOut) return `timed out after ${result.durationMs}ms`;
  if (result.exitCode !== null) return `exited ${result.exitCode} after ${result.durationMs}ms`;
  return result.reason ?? 'did not finish';
}

/**
 * The failing hooks as a verdict for the working stage, delivered the way a
 * failed QA verdict is (`pendingFeedback`). Only the command OUTPUT reaches the
 * model; the command itself is the operator's, and the stage is told it
 * cannot change it.
 */
export function evidenceRepairFeedback(results: EvidenceHookResult[], repair: number): QAValidationResult {
  const failed = results.filter(result => !result.passed);
  return {
    passed: false,
    issues: failed.map(result => `Evidence hook "${result.name}" (\`${result.command}\`) failed: ${describeRun(result)}` +
      (result.outputExcerpt ? `\n${result.outputExcerpt}` : '')),
    feedback: `The project's evidence hooks failed against your work (repair ${repair} of ${EVIDENCE_REPAIR_LIMIT}). ` +
      'These commands are configured by the operator and run automatically after your stage; you cannot change or skip them, ' +
      'and the deliverable is not accepted until every one exits 0. Fix the code so they pass; do not weaken or delete tests or checks to get there.',
    retryCount: repair,
  };
}

/** The passing results, stated to the auditor as ground truth. */
export function evidenceGroundTruth(results: EvidenceHookResult[]): string {
  return 'EVIDENCE HOOKS (run by the pipeline, not by you — configured by the operator for this project):\n' +
    results.map(result => `- ${result.name}: \`${result.command}\` — ${describeRun(result)}`).join('\n') +
    '\n\nThat is the ground truth for this stage. Do not re-run them to check; judge whether the work is right and complete.';
}

/** One line per hook for a run summary or a stop message. */
export function evidenceSummary(results: EvidenceHookResult[]): string {
  return results.map(result => `${result.passed ? 'PASS' : 'FAIL'} ${result.name} (\`${result.command}\`): ${describeRun(result)}` +
    (!result.passed && result.outputExcerpt ? `\n${result.outputExcerpt}` : '')).join('\n');
}
