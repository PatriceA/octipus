/**
 * Start a turn when a check turns red, not on every check delivery.
 *
 * A webhook hook on `check_run` gets one delivery per check per push, most of
 * them green, and each one used to cost a full agent turn. With
 * `actionConfig.onlyOnChange`, code decides first (after DeepSeek Harness's
 * event-trigger proposal: change detection and merging in code, the model only
 * for what survives):
 *
 *  - A check result is reduced to `pass`, `fail` or `other` and compared with
 *    the last one stored for the same hook, subject (repository and pull
 *    request, else branch) and check name. Only a turn to `fail` from anything
 *    else is a change. A check that stays red is not; a pass followed by a new
 *    failure is again. `other` (cancelled, pending) neither counts nor resets.
 *  - Changes to one subject within the merge window become one turn: a push
 *    that fails three checks wakes the agent once, with the three names.
 *  - Events that are not check results (comments, reviews, opened PRs) carry
 *    new content every time and are not filtered.
 *
 * State lives in the key-value store for 30 days. It is written when the
 * merged turn fires, not when the change is seen: a restart inside the window
 * loses that turn, and the next red result of the same check is a change again
 * instead of being swallowed. Pending merges are in this process only.
 */
import { getStorageProvider } from '@/db/storage';
import { coreLogger } from '@/utils/logger';

export type CheckState = 'pass' | 'fail' | 'other';

export interface CheckObservation {
  /** `owner/repo#12` or `owner/repo@branch`. */
  subject: string;
  /** The check, workflow or status context. */
  name: string;
  state: CheckState;
  /** The provider's word for it (`failure`, `timed_out`, …). */
  conclusion: string;
}

const FAIL = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'error']);
const PASS = new Set(['success', 'neutral', 'skipped']);

export function checkState(conclusion: unknown): CheckState {
  if (typeof conclusion !== 'string') return 'other';
  if (FAIL.has(conclusion)) return 'fail';
  if (PASS.has(conclusion)) return 'pass';
  return 'other';
}

const STATE_TTL_SECONDS = 30 * 24 * 60 * 60;
export const DEFAULT_MERGE_WINDOW_SECONDS = 60;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function subjectOf(repo: string, pullRequests: unknown, branch: unknown): string {
  const first = Array.isArray(pullRequests) ? obj(pullRequests[0]) : undefined;
  const number = first?.number;
  if (typeof number === 'number') return `${repo}#${number}`;
  return `${repo}@${str(branch) ?? 'unknown'}`;
}

/**
 * The check result a GitHub delivery reports, or null when it is not one
 * (or not finished): `check_run`, `check_suite` and `workflow_run` once
 * `completed`, and commit `status`.
 */
export function observeGithubCheck(eventType: string | undefined, body: unknown): CheckObservation | null {
  const p = obj(body);
  const repo = str(obj(p?.repository)?.full_name);
  if (!p || !repo || !eventType) return null;
  if (eventType === 'check_run' && p.action === 'completed') {
    const run = obj(p.check_run);
    const name = str(run?.name);
    if (!run || !name) return null;
    return { subject: subjectOf(repo, run.pull_requests, obj(run.check_suite)?.head_branch), name, state: checkState(run.conclusion), conclusion: String(run.conclusion) };
  }
  if (eventType === 'check_suite' && p.action === 'completed') {
    const suite = obj(p.check_suite);
    if (!suite) return null;
    const name = `suite:${str(obj(suite.app)?.slug) ?? 'unknown'}`;
    return { subject: subjectOf(repo, suite.pull_requests, suite.head_branch), name, state: checkState(suite.conclusion), conclusion: String(suite.conclusion) };
  }
  if (eventType === 'workflow_run' && p.action === 'completed') {
    const run = obj(p.workflow_run);
    const name = str(run?.name);
    if (!run || !name) return null;
    return { subject: subjectOf(repo, run.pull_requests, run.head_branch), name, state: checkState(run.conclusion), conclusion: String(run.conclusion) };
  }
  if (eventType === 'status') {
    const name = str(p.context);
    if (!name) return null;
    const branches = Array.isArray(p.branches) ? p.branches : [];
    const state = p.state === 'pending' ? 'other' : checkState(p.state);
    return { subject: subjectOf(repo, undefined, obj(branches[0])?.name ?? str(p.sha)?.slice(0, 12)), name, state, conclusion: String(p.state) };
  }
  return null;
}

const stateKey = (hookId: string, o: Pick<CheckObservation, 'subject' | 'name'>) => `hook-check:${hookId}:${o.subject}:${o.name}`;

/** Is this observation a change for the hook? Reads, never writes. */
export async function isCheckChange(hookId: string, o: CheckObservation): Promise<{ change: boolean; previous: CheckState | null }> {
  const previous = (await getStorageProvider().getRaw(stateKey(hookId, o))) as CheckState | null;
  return { change: o.state === 'fail' && previous !== 'fail', previous };
}

/** Store what the hook has now seen for each check (non-`other` only). */
export async function recordCheckStates(hookId: string, observations: CheckObservation[]): Promise<void> {
  const storage = getStorageProvider();
  for (const o of observations) {
    if (o.state !== 'other') await storage.setRaw(stateKey(hookId, o), o.state, STATE_TTL_SECONDS);
  }
}

/** One line per changed check, for the turn's event block. */
export function describeChanges(changes: CheckObservation[]): string {
  return [`Checks that turned failing on ${changes[0]?.subject ?? 'this subject'}:`,
    ...changes.map((c) => `- ${c.name}: ${c.conclusion}`)].join('\n');
}

interface Pending { timer: ReturnType<typeof setTimeout>; changes: CheckObservation[] }
const pending = new Map<string, Pending>();

/**
 * Merge a change into the subject's pending turn, starting the window on the
 * first one. `fire` runs once per window with every change seen in it; it is
 * awaited inside the timer and its failure is logged, as no caller is left.
 * Returns whether this change opened the window.
 */
export function mergeCheckChange(
  hookId: string,
  change: CheckObservation,
  windowMs: number,
  fire: (changes: CheckObservation[]) => Promise<void>,
): boolean {
  const key = `${hookId}\u0000${change.subject}`;
  const open = pending.get(key);
  if (open) {
    if (!open.changes.some((c) => c.name === change.name)) open.changes.push(change);
    return false;
  }
  const entry: Pending = {
    changes: [change],
    timer: setTimeout(() => {
      pending.delete(key);
      fire(entry.changes).catch((err) => coreLogger.error({ err, hookId, subject: change.subject }, 'Merged check-change turn failed'));
    }, windowMs),
  };
  entry.timer.unref?.();
  pending.set(key, entry);
  return true;
}

/** Test seam. */
export function resetPendingCheckChanges(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
}
