import { z } from 'zod';

/** Default and ceiling for one hook's run, matching the `command_exit_zero` gate it runs through. */
export const EVIDENCE_HOOK_DEFAULT_TIMEOUT_MS = 120_000;
export const EVIDENCE_HOOK_MAX_TIMEOUT_MS = 600_000;
export const EVIDENCE_HOOK_MIN_TIMEOUT_MS = 1_000;
/** Same bound as a verification command a parent attaches (`MAX_COMMAND_SCORER_LEN`). */
export const EVIDENCE_HOOK_MAX_COMMAND_LEN = 500;

/**
 * One project evidence hook: a command whose exit code counts as completion
 * evidence for pipeline work done in `root`.
 *
 * Operator configuration (the `agent.evidenceHooks` setting), never model
 * output: nothing a stage writes is substituted into `command`, and the
 * pipeline runs it as written. Its shape (argv only, no shell syntax) is
 * checked again when it runs, by the same rules every verification command
 * goes through (`commandScorerShapeError`); that check lives with the shell
 * policy, which this config schema must not import.
 */
export const evidenceHookSchema = z.object({
  /** Short label shown with the result: `test`, `build`, `lint`, `typecheck`. */
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,39}$/, 'Use a short name such as "test" or "build"'),
  command: z.string().trim().min(1).max(EVIDENCE_HOOK_MAX_COMMAND_LEN)
    .refine(value => !/[\x00-\x1f]/.test(value), 'A hook command is one line'),
  /**
   * The project folder this hook belongs to. It applies to a pipeline whose
   * stages work in this folder or below it, and nowhere else.
   */
  root: z.string().min(1).refine(value => /^(\/|[A-Za-z]:[\\/])/.test(value) && !/[\x00-\x1f]/.test(value), 'Choose an absolute project directory'),
  timeoutMs: z.number().int().min(EVIDENCE_HOOK_MIN_TIMEOUT_MS).max(EVIDENCE_HOOK_MAX_TIMEOUT_MS).default(EVIDENCE_HOOK_DEFAULT_TIMEOUT_MS),
}).strict();
export type EvidenceHook = z.infer<typeof evidenceHookSchema>;

/**
 * Ceiling on the timeouts of all configured hooks together. Any of them can
 * run in one visit (a run whose folder holds every hook root), so the sum is
 * what bounds how long a pipeline can sit in its evidence checks.
 */
export const EVIDENCE_HOOKS_MAX_TOTAL_MS = 1_800_000;

export const evidenceHooksSchema = z.array(evidenceHookSchema).max(50).superRefine((hooks, ctx) => {
  const keys = hooks.map(hook => `${hook.root}\u0000${hook.name}`);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Hook names must be unique within a project folder' });
  const total = hooks.reduce((sum, hook) => sum + hook.timeoutMs, 0);
  if (total > EVIDENCE_HOOKS_MAX_TOTAL_MS) {
    ctx.addIssue({ code: 'custom', message: `The hooks' timeouts add up to ${total}ms; all hooks together may take at most ${EVIDENCE_HOOKS_MAX_TOTAL_MS}ms (30 minutes)` });
  }
});

/** What one hook run produced, as stored in `verification_evidence.detail` (`kind: 'pre_verify'`). */
export interface EvidenceHookResult {
  name: string;
  command: string;
  /** The hook's configured root: the folder it ran in, and why it applied to this run. */
  root?: string;
  /** Exit 0 within its time limit. */
  passed: boolean;
  /** Null when the process was killed or never started. */
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  /** The end of the output (stderr first), at most ~2000 characters. */
  outputExcerpt: string;
  /** Why it failed or was not run, when it did not pass. */
  reason?: string;
  /**
   * Not run at all for a reason the working stage cannot fix: permission
   * denied, a command the shell policy refuses, a missing workspace. Such a
   * hook pauses the run for the operator instead of going back for repair.
   */
  refused?: boolean;
}
