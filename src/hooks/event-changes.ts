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
 *  - A delivery for a check that has not finished (`created`, `in_progress`,
 *    `requested`, a pending status) starts nothing.
 *
 * The gate runs in HookManager before cooldown and the run reservation, so a
 * skipped delivery uses neither; the merged turn goes back through
 * `triggerHook`, which re-reads the hook (still enabled, owner still active),
 * reserves its run and logs it.
 *
 * State lives in the key-value store for 30 days, each entry stamped with when
 * it was observed. A pass is written when it arrives; a failure when the
 * merged turn fires, and only if nothing newer was written meanwhile, so a
 * re-run that passed inside the window is not overwritten by the stale failure.
 * A restart inside the window loses that turn, and the next red result of the
 * same check is a change again instead of being swallowed. Pending merges are
 * in this process only.
 */
import type { Hook } from '@/core/types';
import { getStorageProvider } from '@/db/storage';
import { coreLogger } from '@/utils/logger';
import type { ActionResult } from './actions';
import type { TriggerContext } from './triggers';

export type CheckState = 'pass' | 'fail' | 'other';

export interface CheckObservation {
  /** `owner/repo#12` or `owner/repo@branch`. */
  subject: string;
  /** The check, workflow or status context. */
  name: string;
  state: CheckState;
  /** The provider's word for it (`failure`, `timed_out`, …), or the delivery's action while unfinished. */
  conclusion: string;
  /** When this delivery was seen (ms). */
  observedAt: number;
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
 * The check result a GitHub delivery reports, or null when the delivery is not
 * about a check: `check_run`, `check_suite`, `workflow_run` and commit
 * `status`. A check that has not finished is observed with state `other`.
 */
export function observeGithubCheck(eventType: string | undefined, body: unknown, now = Date.now()): CheckObservation | null {
  const p = obj(body);
  const repo = str(obj(p?.repository)?.full_name);
  if (!p || !repo || !eventType) return null;
  const done = p.action === 'completed';
  const make = (subject: string, name: string, conclusion: unknown): CheckObservation => ({
    subject, name, state: done ? checkState(conclusion) : 'other',
    conclusion: done ? String(conclusion) : String(p.action ?? 'unfinished'), observedAt: now,
  });
  if (eventType === 'check_run') {
    const run = obj(p.check_run);
    const name = str(run?.name);
    if (!run || !name) return null;
    return make(subjectOf(repo, run.pull_requests, obj(run.check_suite)?.head_branch), name, run.conclusion);
  }
  if (eventType === 'check_suite') {
    const suite = obj(p.check_suite);
    if (!suite) return null;
    return make(subjectOf(repo, suite.pull_requests, suite.head_branch), `suite:${str(obj(suite.app)?.slug) ?? 'unknown'}`, suite.conclusion);
  }
  if (eventType === 'workflow_run') {
    const run = obj(p.workflow_run);
    const name = str(run?.name);
    if (!run || !name) return null;
    return make(subjectOf(repo, run.pull_requests, run.head_branch), name, run.conclusion);
  }
  if (eventType === 'status') {
    const name = str(p.context);
    if (!name) return null;
    const branches = Array.isArray(p.branches) ? p.branches : [];
    const state = p.state === 'pending' ? 'other' : checkState(p.state);
    return { subject: subjectOf(repo, undefined, obj(branches[0])?.name ?? str(p.sha)?.slice(0, 12)), name, state, conclusion: String(p.state), observedAt: now };
  }
  return null;
}

const stateKey = (hookId: string, o: Pick<CheckObservation, 'subject' | 'name'>) => `hook-check:${hookId}:${o.subject}:${o.name}`;

interface StoredState { s: CheckState; at: number }

async function readState(hookId: string, o: Pick<CheckObservation, 'subject' | 'name'>): Promise<StoredState | null> {
  const raw = await getStorageProvider().getRaw(stateKey(hookId, o));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredState>;
    return v.s === 'pass' || v.s === 'fail' ? { s: v.s, at: Number(v.at) || 0 } : null;
  } catch (err) {
    coreLogger.warn({ err, hookId, subject: o.subject, check: o.name }, 'Unreadable stored check state; treating as none');
    return null;
  }
}

/** Is this observation a change for the hook? Reads, never writes. */
export async function isCheckChange(hookId: string, o: CheckObservation): Promise<{ change: boolean; previous: CheckState | null }> {
  const previous = (await readState(hookId, o))?.s ?? null;
  return { change: o.state === 'fail' && previous !== 'fail', previous };
}

/**
 * Store what the hook has now seen for each check (`other` is never stored).
 * An observation older than the stored one is not written: a pass recorded
 * while a failure waited in its merge window stays.
 */
export async function recordCheckStates(hookId: string, observations: CheckObservation[]): Promise<void> {
  const storage = getStorageProvider();
  for (const o of observations) {
    if (o.state === 'other') continue;
    const stored = await readState(hookId, o);
    if (stored && stored.at > o.observedAt) continue;
    await storage.setRaw(stateKey(hookId, o), JSON.stringify({ s: o.state, at: o.observedAt } satisfies StoredState), STATE_TTL_SECONDS);
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

/**
 * An `onlyOnChange` hook's filter, run by HookManager before cooldown and the
 * run reservation. Returns the result to log instead of a run, or the context
 * the run goes ahead with. `fire` runs the merged turn when its window closes
 * (HookManager passes `triggerHook`, which re-checks and logs it).
 */
export async function gateCheckChange(
  hook: Hook,
  context: TriggerContext,
  fire: (context: TriggerContext) => Promise<void>,
): Promise<{ result: ActionResult } | { context: TriggerContext }> {
  const config = hook.actionConfig ?? {};
  if (hook.action !== 'spawn_agent' || config.onlyOnChange !== true || !context.webhook || context.checkChanges) return { context };
  // A read-only hook that is not orchestrated fails at once in the action;
  // deferring it would only delay the error past the log.
  if (config.readOnly === true && config.orchestrated !== true) return { context };
  const observed = observeGithubCheck(context.webhook.headers?.['x-github-event'], context.webhook.body);
  if (!observed) return { context };
  const check = { subject: observed.subject, name: observed.name, state: observed.state };
  if (observed.state === 'other') return { result: { success: true, data: { skipped: 'check not finished', check } } };
  const { change, previous } = await isCheckChange(hook.id, observed);
  if (!change) {
    await recordCheckStates(hook.id, [observed]);
    return { result: { success: true, data: { skipped: 'no change', check, previous } } };
  }
  const seconds = Number(config.changeMergeWindowSeconds ?? DEFAULT_MERGE_WINDOW_SECONDS);
  const windowMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  if (windowMs === 0) {
    // No window: this delivery is the turn. The trigger context is shared with
    // every hook the delivery matched, so a copy carries the change.
    await recordCheckStates(hook.id, [observed]);
    return { context: { ...context, checkChanges: [observed] } };
  }
  const opened = mergeCheckChange(hook.id, observed, windowMs, async (merged) => {
    await recordCheckStates(hook.id, merged);
    await fire({ ...context, checkChanges: merged });
  });
  return { result: { success: true, data: { deferred: true, merged: !opened, check, previous, windowSeconds: windowMs / 1000 } } };
}

/** Test seam. */
export function resetPendingCheckChanges(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
}
