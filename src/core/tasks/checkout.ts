/**
 * Work-board checkout lease. The rule itself lives in SQL (ScopedTaskRepo's
 * checkout and `update(..., { asActor })`), judged on the database clock:
 * `checkedOutAt` is written with now() and compared against now().
 *
 * A checkout is a lease, not a lock: it lapses TASK_CHECKOUT_TTL_MS after
 * `checkedOutAt`, and a lapsed claim can be taken over by anyone. A holder
 * that is still working renews it by checking out again (re-checkout is
 * idempotent and moves `checkedOutAt` to now). That is how a crashed agent's
 * claim clears itself without a reaper.
 */

/** How long a checkout holds without renewal. */
export const TASK_CHECKOUT_TTL_MS = 30 * 60 * 1000;
