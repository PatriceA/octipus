/**
 * Work-board checkout rules, pure (no database), shared by the scoped repo
 * and the tasks tool.
 *
 * A checkout is a lease, not a lock: it lapses TASK_CHECKOUT_TTL_MS after
 * `checkedOutAt`, and a lapsed claim can be taken over by anyone. A holder
 * that is still working renews it by checking out again (re-checkout is
 * idempotent and moves `checkedOutAt` to now). That is how a crashed agent's
 * claim clears itself without a reaper.
 */

/** How long a checkout holds without renewal. */
export const TASK_CHECKOUT_TTL_MS = 30 * 60 * 1000;

/** The subset of a task row the checkout rules read. */
export interface CheckoutState {
  checkedOutBy?: string | null;
  checkedOutAt?: Date | string | null;
}

/** True when the checkout is held and its lease has not lapsed. */
export function isCheckoutLive(task: CheckoutState, now: Date = new Date()): boolean {
  if (!task.checkedOutBy || !task.checkedOutAt) return false;
  return new Date(task.checkedOutAt).getTime() > now.getTime() - TASK_CHECKOUT_TTL_MS;
}

/** The holder that keeps `actor` off the task, or null when it may proceed. */
export function otherHolder(task: CheckoutState, actor: string, now: Date = new Date()): string | null {
  return isCheckoutLive(task, now) && task.checkedOutBy !== actor ? task.checkedOutBy ?? null : null;
}
