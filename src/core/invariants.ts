/**
 * Runtime invariants — checks that run where the product runs.
 *
 * Rebuild plan, Phase 4. Every inert gate this repository has shipped was
 * green in CI: a role-fit check keyed to a tier no path can carry, an audit
 * rule fed by a block that was stripped before it was parsed, an evidence gate
 * a template never declared into. CI proved the guard could fail. Nothing
 * proved the running system ever reached it.
 *
 * So an invariant here asserts over the value the runtime actually resolves,
 * or over rows the product actually wrote — never that a function or a field
 * exists, which is what a type checker is for. A failure is attributed to its
 * area and logged loudly; it never stops the boot, because a check that can
 * take the server down is a check nobody dares write.
 */
import { and, eq, gt, notExists, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { runEvents } from '@/db/schema/run-events';
import { swarmNodes } from '@/db/schema/swarm-nodes';
import { coreLogger } from '@/utils/logger';

/** `null` when the invariant holds; a human-readable violation otherwise. */
export type InvariantCheck = () => Promise<string | null>;

export interface Invariant {
  /** Owning area, e.g. `swarm`. Failures are attributed to it. */
  area: string;
  /** What is being asserted, phrased as the thing that must be true. */
  name: string;
  check: InvariantCheck;
}

export interface InvariantResult {
  area: string;
  name: string;
  /**
   * Violation text, or `null` when it holds — but `null` alone does NOT mean
   * the invariant passed: read `error` first. A check that could not run is
   * an unknown answer, and treating it as a pass is how a gate goes quiet.
   */
  violation: string | null;
  /** Set when the check itself failed — an unknown answer, not a passing one. */
  error?: string;
}

const registry = new Map<string, Invariant>();

/** Register one invariant. Re-registering the same area+name replaces it. */
export function registerInvariant(inv: Invariant): void {
  registry.set(`${inv.area}/${inv.name}`, inv);
}

/**
 * Run every registered invariant and return one result each.
 *
 * A check that throws is reported as an error rather than as a pass: not
 * knowing is not the same as being fine, and treating it as a pass is how a
 * gate goes quiet.
 */
export async function runInvariants(
  /** Optional filter — used by tests so they run their own probes only. */
  select?: (inv: Invariant) => boolean,
): Promise<InvariantResult[]> {
  const results: InvariantResult[] = [];
  for (const inv of registry.values()) {
    if (select && !select(inv)) continue;
    try {
      results.push({ area: inv.area, name: inv.name, violation: await inv.check() });
    } catch (err) {
      results.push({
        area: inv.area,
        name: inv.name,
        violation: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/**
 * Boot pass: run the invariants and log what did not hold. Returns the number
 * of violations so the caller can surface a count.
 */
export async function checkInvariantsAtBoot(): Promise<number> {
  const results = await runInvariants();
  let violations = 0;
  let errors = 0;
  for (const r of results) {
    if (r.error) {
      errors++;
      coreLogger.error({ area: r.area, invariant: r.name, err: r.error }, 'Invariant check failed to run');
    } else if (r.violation) {
      violations++;
      coreLogger.error({ area: r.area, invariant: r.name, detail: r.violation }, 'Runtime invariant violated');
    }
  }
  // Logged even when everything holds, and on purpose. A gate that says
  // nothing when it passes is indistinguishable from a gate that never ran —
  // which is the failure this whole module exists to end, and it would be a
  // poor joke to reproduce it here.
  coreLogger.info(
    { checked: results.length, held: results.length - violations - errors, violations, errors },
    'Runtime invariants checked',
  );
  return violations;
}

// ── The invariants themselves ────────────────────────────────────────

/**
 * The orchestrator's detach budget, read the way the runtime reads it.
 *
 * This is the check the detach-cap incident needed and did not have. The type
 * said six, the config resolved to zero, every unit test agreed with the type,
 * and the orchestrator quietly blocked on every spawn for weeks. Asserting the
 * schema default in CI is not enough — the value that matters is the one
 * `getLevelDefault` returns after this deployment's settings have been merged.
 */
registerInvariant({
  area: 'swarm',
  name: 'the orchestrator level resolves a non-zero detach cap',
  async check() {
    // Touch config FIRST, and let a failure throw. `getLevelDefault` swallows a
    // config error and falls back to the hardcoded record, whose value is 6 —
    // so asking it alone would answer "holds" for a deployment whose config
    // never loaded, which is the inert-gate shape this check exists to catch.
    const { getConfig } = await import('@/config');
    const level = getConfig().swarm?.levelDefaults?.orchestrator;
    if (!level) return 'config carries no swarm.levelDefaults.orchestrator: the runtime is running on hardcoded fallbacks';
    const { getLevelDefault } = await import('./swarm/types');
    const cap = getLevelDefault(0).maxPendingDetached;
    return cap > 0
      ? null
      : `getLevelDefault(0).maxPendingDetached resolved to ${cap}: spawn_child falls back to a blocking await and collect_children finds nothing`;
  },
});

/**
 * Every child node has the durable start that recovery keys off.
 *
 * `findRootsWithIncomplete` and `replay` both look for a `spawn` event; a node
 * row without one can never be reconciled, only aged out by the reaper. The
 * spawn path now refuses to run a child it could not record, so a row here is
 * evidence that some path writes a node without its bracket — the shape of the
 * bug, not one instance of it.
 *
 * Depth 0 is excluded deliberately: the root orchestrator node is the process's
 * own agent, its row is best-effort by design, and it is stopped through the
 * agent manager rather than through reconciliation.
 */
registerInvariant({
  area: 'swarm',
  name: 'every spawned child node has a ledger start event',
  async check() {
    const [row] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(swarmNodes)
      .where(
        and(
          gt(swarmNodes.depth, 0),
          // Only nodes that are still in flight. A terminal row needs nothing
          // from replay or reconcile, so reporting one is noise nobody can act
          // on — including the rows the spawn path itself cancels when it
          // refuses to run a child it could not record, and every row written
          // before the bracket existed.
          eq(swarmNodes.status, 'running'),
          notExists(
            getDb()
              .select({ one: sql`1` })
              .from(runEvents)
              .where(
                and(
                  eq(runEvents.subject, 'swarm_node'),
                  eq(runEvents.event, 'spawn'),
                  eq(runEvents.subjectId, swarmNodes.id),
                ),
              ),
          ),
        ),
      );
    const missing = row?.n ?? 0;
    return missing === 0
      ? null
      : `${missing} running swarm_nodes row(s) below the root have no 'spawn' event: they are invisible to replay and to the boot reconcile`;
  },
});
