/**
 * Swarm ledger — append-only event log + deterministic replay/reconcile.
 *
 * Idea #2 from `.octipus/codewhale-borrowed-ideas.md` (CodeWhale's Fleet
 * ledger). `swarm_nodes` holds current state; this holds the *history* of
 * transitions so a swarm interrupted by a crash/restart can be replayed and
 * reconciled deterministically.
 *
 * Two halves:
 *  - Pure functions (`replayEvents`, `computeReconciliation`) fold an ordered
 *    event list into the reconstructed node set and the list of in-flight
 *    nodes that need reconciling. No I/O — fully unit-testable.
 *  - `SwarmLedger` wires those to the DB: append on spawn/terminal, and an
 *    idempotent `reconcile` that marks orphaned in-flight nodes terminal.
 *
 * Reconciliation is idempotent: it APPENDS a `reconcile` event (treated as
 * terminal by the fold) rather than mutating prior rows, so a second pass
 * finds nothing in-flight. It does NOT re-execute agents — reviving the actual
 * model work is a separate, larger step (documented as a follow-up).
 */

import { coreLogger } from '@/utils/logger';
import { type SwarmLedgerRepository, swarmLedgerRepository } from './ledger-repository';
import { type SwarmNodeRepository, swarmNodeRepository } from './node-repository';
import type { SwarmNodeStatus } from './types';

/**
 * Event kinds a swarm node goes through — a subset of the `run_event_type` pg
 * enum, which also carries pipeline and tool events. Defined at the repository
 * boundary and re-exported here, where every existing importer expects it.
 */
export type { SwarmLedgerEventType } from './ledger-repository';
import type { SwarmLedgerEventType } from './ledger-repository';

/** Events that close out a node — after one, the node is no longer in-flight. */
const TERMINAL_EVENTS: ReadonlySet<SwarmLedgerEventType> = new Set([
  'result',
  'cancel',
  'reconcile',
]);

/** One ledger event as the fold sees it (seq-ordered). */
export interface SwarmLedgerEvent {
  seq: number;
  nodeId: string;
  parentNodeId: string | null;
  event: SwarmLedgerEventType;
  /** Append time in epoch ms — used by reconcile's age guard. */
  createdAtMs: number;
  payload?: SwarmLedgerPayload | null;
}

/** Event-specific detail. All optional — different events fill different bits. */
export interface SwarmLedgerPayload {
  /** Terminal status for `result`/`cancel`/`reconcile` events. */
  status?: SwarmNodeStatus;
  topicPath?: string;
  role?: string;
  depth?: number;
  reason?: string;
}

/** A node as reconstructed by replay. */
export interface ReplayNode {
  nodeId: string;
  parentNodeId: string | null;
  /** Terminal status, or `'in_flight'` when no terminal event was seen. */
  status: SwarmNodeStatus | 'in_flight';
  spawnSeq: number;
  lastSeq: number;
  /** Append time (epoch ms) of this node's most recent event. */
  lastEventAtMs: number;
  topicPath?: string;
  role?: string;
  depth?: number;
}

export interface SwarmReplayState {
  nodes: Map<string, ReplayNode>;
  /** Node ids still `in_flight` (spawned, never terminated). */
  incomplete: string[];
}

/** Default terminal status when an event carries none in its payload. */
function defaultTerminalStatus(event: SwarmLedgerEventType): SwarmNodeStatus {
  return event === 'cancel' || event === 'reconcile' ? 'cancelled' : 'completed';
}

/**
 * Fold an ordered (by `seq`) event list into the reconstructed node set.
 * Pure and deterministic — same events in, same state out. Tolerates a
 * terminal event whose `spawn` was lost (treats it as a stub node) so a
 * partial ledger never throws.
 */
export function replayEvents(events: SwarmLedgerEvent[]): SwarmReplayState {
  const nodes = new Map<string, ReplayNode>();

  for (const e of events) {
    const existing = nodes.get(e.nodeId);

    if (e.event === 'spawn') {
      // A duplicate spawn (shouldn't happen) just refreshes metadata; keep the
      // earliest spawnSeq and any already-recorded terminal status (a spawn
      // that lands after its own terminal — possible with fire-and-forget
      // writes — must NOT resurrect the node to in_flight).
      nodes.set(e.nodeId, {
        nodeId: e.nodeId,
        parentNodeId: e.parentNodeId,
        status: existing && existing.status !== 'in_flight' ? existing.status : 'in_flight',
        spawnSeq: existing?.spawnSeq ?? e.seq,
        lastSeq: e.seq,
        lastEventAtMs: e.createdAtMs,
        topicPath: e.payload?.topicPath ?? existing?.topicPath,
        role: e.payload?.role ?? existing?.role,
        depth: e.payload?.depth ?? existing?.depth,
      });
      continue;
    }

    const node: ReplayNode = existing ?? {
      nodeId: e.nodeId,
      parentNodeId: e.parentNodeId,
      status: 'in_flight',
      spawnSeq: e.seq,
      lastSeq: e.seq,
      lastEventAtMs: e.createdAtMs,
    };
    node.lastSeq = e.seq;
    node.lastEventAtMs = e.createdAtMs;
    if (TERMINAL_EVENTS.has(e.event)) {
      node.status = e.payload?.status ?? defaultTerminalStatus(e.event);
    }
    nodes.set(e.nodeId, node);
  }

  const incomplete = [...nodes.values()]
    .filter((n) => n.status === 'in_flight')
    .map((n) => n.nodeId);

  return { nodes, incomplete };
}

/** A reconcile decision for one orphaned in-flight node. */
export interface ReconcileAction {
  nodeId: string;
  parentNodeId: string | null;
  newStatus: SwarmNodeStatus;
  reason: string;
}

/** Reason recorded on nodes reconciled by a resume pass. */
export const RECONCILE_REASON = 'orphaned_at_resume';

/**
 * Pure: derive the reconcile actions for a replayed state. Each in-flight node
 * becomes a `cancelled` action — a resume marks interrupted work terminal
 * (fail loud) rather than silently leaving it `running` forever.
 *
 * The age guard (`olderThanMs` + `nowMs`) is the multi-instance safety: a
 * sibling process may be ACTIVELY running a freshly-spawned node, so we only
 * reconcile nodes whose last event is older than the threshold — matching the
 * orphan reaper's `olderThanMs` so the ledger is never more aggressive than it.
 * Omit the options (or pass `olderThanMs <= 0`) to reconcile all in-flight
 * nodes regardless of age (used by unit tests).
 */
export function computeReconciliation(
  state: SwarmReplayState,
  opts: { olderThanMs?: number; nowMs?: number } = {},
): ReconcileAction[] {
  const olderThanMs = opts.olderThanMs ?? 0;
  const nowMs = opts.nowMs ?? 0;
  const actions: ReconcileAction[] = [];
  for (const nodeId of state.incomplete) {
    const node = state.nodes.get(nodeId);
    if (olderThanMs > 0 && node && nowMs - node.lastEventAtMs < olderThanMs) {
      // Too recent — a live sibling instance may still be running it. Skip.
      continue;
    }
    actions.push({
      nodeId,
      parentNodeId: node?.parentNodeId ?? null,
      newStatus: 'cancelled',
      reason: RECONCILE_REASON,
    });
  }
  return actions;
}

export interface ReconcileResult {
  rootSessionId: string;
  /** Number of in-flight nodes marked terminal this pass. */
  reconciled: number;
  nodeIds: string[];
}

/**
 * Default age threshold for boot reconcile — aligned with the orphan reaper's
 * interval so the ledger never terminalizes nodes the reaper would consider
 * too young. Falls back to 10 minutes when config isn't loaded.
 */
function defaultReconcileAgeMs(): number {
  try {
    // Lazy require so this module stays importable without a config pipeline.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getConfig } = require('@/config');
    return getConfig().swarm?.orphanReaperIntervalMs ?? 600_000;
  } catch {
    return 600_000;
  }
}

/** Map a DB ledger record to the in-memory event shape the fold consumes. */
function toEvent(r: {
  seq: number;
  nodeId: string;
  parentNodeId: string | null;
  event: SwarmLedgerEventType;
  payload: unknown;
  createdAt: Date;
}): SwarmLedgerEvent {
  return {
    seq: typeof r.seq === 'number' ? r.seq : Number(r.seq),
    nodeId: r.nodeId,
    parentNodeId: r.parentNodeId,
    event: r.event,
    createdAtMs: r.createdAt instanceof Date ? r.createdAt.getTime() : new Date(r.createdAt).getTime(),
    payload: (r.payload as SwarmLedgerPayload | null) ?? null,
  };
}

/**
 * The ledger's write + replay + reconcile surface.
 *
 * Writes are best-effort — logged, never thrown — with one deliberate
 * exception: `recordSpawn` is the durable start of a node's bracket and throws,
 * because a node with no recorded start is invisible to every recovery path.
 * See its own comment for the asymmetry.
 */
export class SwarmLedger {
  constructor(
    // Narrowed to the methods actually used so the dependency surface is
    // explicit and test fakes can satisfy it without `as unknown as` casts.
    private readonly repo: Pick<
      SwarmLedgerRepository,
      'append' | 'findByRoot' | 'findRootsWithIncomplete'
    > = swarmLedgerRepository,
    private readonly nodes: Pick<SwarmNodeRepository, 'cancelIfRunning'> = swarmNodeRepository,
  ) {}

  /**
   * Record that a child node was created and started running.
   *
   * The one write here that is NOT best-effort. It is the durable start of the
   * node's bracket, and every crash-recovery path keys off it:
   * `findRootsWithIncomplete` looks for a `spawn` with no terminal, and
   * `replay` cannot see a node that has none. The two failures cost very
   * different things — a dropped terminal leaves the node in-flight, so the
   * next reconcile cancels it (safe direction), while a dropped spawn makes a
   * running child invisible to reconciliation for good. So this one throws and
   * the caller must not run the child.
   */
  async recordSpawn(e: {
    rootSessionId: string;
    nodeId: string;
    parentNodeId: string | null;
    topicPath?: string;
    role?: string;
    depth?: number;
  }): Promise<void> {
    await this.repo.append({
      rootSessionId: e.rootSessionId,
      nodeId: e.nodeId,
      parentNodeId: e.parentNodeId,
      event: 'spawn',
      payload: { topicPath: e.topicPath, role: e.role, depth: e.depth },
    });
  }

  /** Record a node reaching a terminal status. */
  async recordTerminal(e: {
    rootSessionId: string;
    nodeId: string;
    parentNodeId: string | null;
    status: SwarmNodeStatus;
  }): Promise<void> {
    await this.safeAppend({
      rootSessionId: e.rootSessionId,
      nodeId: e.nodeId,
      parentNodeId: e.parentNodeId,
      event: e.status === 'cancelled' ? 'cancel' : 'result',
      payload: { status: e.status },
    });
  }

  /** Reconstruct a root's node tree from its ledger. */
  async replay(rootSessionId: string): Promise<SwarmReplayState> {
    const rows = await this.repo.findByRoot(rootSessionId);
    return replayEvents(rows.map(toEvent));
  }

  /**
   * Idempotently reconcile one root: mark every in-flight node terminal by
   * appending a `reconcile` event and flipping the `swarm_nodes` row to
   * `cancelled` if it is still `running`. Running it twice is a no-op (the
   * appended reconcile events make the nodes terminal in the next replay).
   *
   * `olderThanMs` is the multi-instance safety threshold (see
   * `computeReconciliation`): nodes whose last event is more recent are left
   * alone so a sibling process actively running them isn't cancelled. Defaults
   * to the orphan reaper's interval so the two stay aligned.
   */
  async reconcile(rootSessionId: string, opts: { olderThanMs?: number } = {}): Promise<ReconcileResult> {
    const state = await this.replay(rootSessionId);
    const olderThanMs = opts.olderThanMs ?? defaultReconcileAgeMs();
    const actions = computeReconciliation(state, { olderThanMs, nowMs: Date.now() });

    for (const action of actions) {
      // Append the durable reconcile event first — even if the node-table
      // flip below fails, the history records the decision.
      await this.safeAppend({
        rootSessionId,
        nodeId: action.nodeId,
        parentNodeId: action.parentNodeId,
        event: 'reconcile',
        payload: { status: action.newStatus, reason: action.reason },
      });
      try {
        await this.nodes.cancelIfRunning(action.nodeId, action.reason);
      } catch (err) {
        coreLogger.error(
          { err, nodeId: action.nodeId },
          'Swarm ledger reconcile — failed to flip node status (event already recorded)',
        );
      }
    }

    if (actions.length > 0) {
      coreLogger.warn(
        { rootSessionId, reconciled: actions.length },
        'Swarm ledger reconcile — marked in-flight nodes terminal',
      );
    }
    return { rootSessionId, reconciled: actions.length, nodeIds: actions.map((a) => a.nodeId) };
  }

  /**
   * Reconcile every root with in-flight nodes. Called once on boot (after DB
   * init) to resume swarms interrupted by the previous process. Bounded to
   * roots that actually have orphaned nodes, and each reconcile is a cheap
   * no-op when the root turns out to be complete.
   */
  async reconcileAllIncomplete(): Promise<{ roots: number; reconciled: number }> {
    let roots = 0;
    let reconciled = 0;
    let rootIds: string[] = [];
    try {
      rootIds = await this.repo.findRootsWithIncomplete();
    } catch (err) {
      coreLogger.error({ err }, 'Swarm ledger reconcile — failed to list incomplete roots');
      return { roots: 0, reconciled: 0 };
    }
    for (const rootSessionId of rootIds) {
      try {
        const r = await this.reconcile(rootSessionId);
        roots++;
        reconciled += r.reconciled;
      } catch (err) {
        coreLogger.error({ err, rootSessionId }, 'Swarm ledger reconcile — root failed, continuing');
      }
    }
    return { roots, reconciled };
  }

  /** Append, swallowing+logging errors so the ledger never breaks a spawn. */
  private async safeAppend(record: {
    rootSessionId: string;
    nodeId: string;
    parentNodeId: string | null;
    event: SwarmLedgerEventType;
    payload?: SwarmLedgerPayload | null;
  }): Promise<void> {
    try {
      await this.repo.append({
        rootSessionId: record.rootSessionId,
        nodeId: record.nodeId,
        parentNodeId: record.parentNodeId,
        event: record.event,
        payload: record.payload ?? null,
      });
    } catch (err) {
      coreLogger.error(
        { err, nodeId: record.nodeId, event: record.event },
        'Swarm ledger append failed — continuing (ledger is a durability aid, not on the critical path)',
      );
    }
  }
}

let instance: SwarmLedger | null = null;
export function getSwarmLedger(): SwarmLedger {
  if (!instance) instance = new SwarmLedger();
  return instance;
}
