/**
 * Swarm Phase 2 — in-memory call graph rooted at `rootSessionId`.
 *
 * Responsibilities:
 *  - Fingerprint set: task-brief dedup across the whole swarm tree.
 *  - Ancestor-chain check: reject a brief whose `topicPath` already appears
 *    in any ancestor's `topicPath`. Defense in depth vs. the fingerprint set
 *    (design §Cycle / Loop Protection).
 *  - Tracks per-node ancestors so the spawner and escalation tool can walk
 *    up the tree cheaply without a DB round-trip.
 *
 * Lifecycle: one graph per root agent root. Keyed by `rootSessionId` in
 * the module-level registry. GC'd when the caller signals `release()`
 * (usually when the root agent completes, fails, or is cancelled).
 *
 * Thread/async safety: pure in-memory mutations guarded by the single-threaded
 * Bun/JS model. No shared state across workers.
 */

import { createHash } from 'crypto';
import type { AgentRole } from '@/core/agent/types';
import { DuplicateSpawnError } from './errors';
import type { TaskBrief } from './types';

/** Lightweight node entry held in the graph. */
export interface CallGraphNode {
  id: string;
  parentNodeId: string | null;
  topicPath: string;
  role: AgentRole;
  briefHash: string;
  /** Captured from `spawn_child` params for escalation lookups. */
  expertId?: string;
  /** One shared escalation allowance per Agent lifetime (design §Escalation). */
  escalationUsed: boolean;
}

/** Immutable stats snapshot (for tests / observability). */
export interface CallGraphSnapshot {
  rootSessionId: string;
  startedAt: number;
  nodeCount: number;
  fingerprintCount: number;
}

/**
 * Stable SHA-256 over the brief's identity-defining fields. Exported so
 * it can be used by the repository cache lookup as well.
 *
 * Moved here from `spawner.ts` (Phase 1) so Phase 2's call-graph owns the
 * canonical implementation. `spawner.ts` now re-exports from this module.
 */
export function taskFingerprint(brief: TaskBrief): string {
  const normalized = brief.taskBrief.trim().replace(/\s+/g, ' ').toLowerCase();
  const artifacts = brief.inputArtifacts
    .map((a) => a.ref)
    .sort()
    .join(',');
  const key = `${brief.topicPath}|${normalized}|${artifacts}`;
  return createHash('sha256').update(key).digest('hex');
}

export class SwarmCallGraph {
  readonly rootSessionId: string;
  readonly startedAt: number;
  private nodes: Map<string, CallGraphNode> = new Map();
  /** Set of fingerprints currently present anywhere in the graph. */
  private fingerprints: Set<string> = new Set();

  constructor(rootSessionId: string) {
    this.rootSessionId = rootSessionId;
    this.startedAt = Date.now();
  }

  /** Register the root root agent node. Idempotent on same id. */
  registerRoot(opts: { id: string; topicPath: string; role: AgentRole }): void {
    if (this.nodes.has(opts.id)) return;
    this.nodes.set(opts.id, {
      id: opts.id,
      parentNodeId: null,
      topicPath: opts.topicPath,
      role: opts.role,
      briefHash: '',
      escalationUsed: false,
    });
  }

  /**
   * Pre-spawn check: reject the brief if
   *   (a) an identical fingerprint is already live in the graph, OR
   *   (b) the child's `topicPath` appears in any ancestor's `topicPath`.
   *
   * On success it **reserves** the fingerprint immediately (before returning),
   * not later in `register()`. The child node is only built after several
   * `await`s, so two identical detached spawns fired in the same tick would
   * both pass a check-only gate and both spawn — the exact duplicate the
   * root agent produced. Reserving here closes that race; the caller must
   * `releaseFingerprint()` if the spawn is then denied before `register()`.
   *
   * Throws `DuplicateSpawnError`. Caller (spawner) catches and returns a
   * `ChildResult{status:'cancelled'}` to the parent LLM, preserving the
   * structured notice so the parent can synthesize against the in-flight
   * result.
   */
  checkSpawn(parentNodeId: string, brief: TaskBrief): { fingerprint: string } {
    const fingerprint = taskFingerprint(brief);

    // (a) fingerprint dedup
    if (this.fingerprints.has(fingerprint)) {
      const existing = this.findByFingerprint(fingerprint);
      throw new DuplicateSpawnError({
        topicPath: brief.topicPath,
        existingNodeId: existing?.id,
        parentNotice: existing
          ? `Subtopic "${brief.topicPath}" already handled by node ${existing.id}. Use its result.`
          : `Subtopic "${brief.topicPath}" is already in flight elsewhere in the swarm.`,
      });
    }

    // (b) ancestor-chain check (defense in depth)
    // `brief.topicPath` is typically "parent/topic/subtopic"; we compare
    // against the spawning parent AND each of its ancestors' topic paths.
    // If the child path matches any of them, reject.
    const parent = this.nodes.get(parentNodeId);
    if (parent && parent.topicPath === brief.topicPath) {
      throw new DuplicateSpawnError({
        topicPath: brief.topicPath,
        existingNodeId: parent.id,
        parentNotice:
          `Subtopic "${brief.topicPath}" is identical to parent ${parent.id}'s topic. ` +
          `Refine the subtopic or synthesize without re-spawning.`,
      });
    }
    for (const ancestor of this.walkAncestors(parentNodeId)) {
      if (ancestor.topicPath === brief.topicPath) {
        throw new DuplicateSpawnError({
          topicPath: brief.topicPath,
          existingNodeId: ancestor.id,
          parentNotice:
            `Subtopic "${brief.topicPath}" already covered by ancestor ${ancestor.id}. ` +
            `Synthesize against its result instead of re-spawning.`,
        });
      }
    }

    // Reserve atomically so a same-tick identical spawn is deduped before this
    // one has built its node (see method doc).
    this.fingerprints.add(fingerprint);
    return { fingerprint };
  }

  /** Record a newly-spawned node. Call only after `checkSpawn` succeeded. */
  register(node: CallGraphNode): void {
    this.nodes.set(node.id, node);
    if (node.briefHash) this.fingerprints.add(node.briefHash);
  }

  /**
   * Release a fingerprint reserved by `checkSpawn` when the spawn is denied
   * before `register()` (fan-out/concurrency/budget/cache). No-op if a
   * registered node still owns it, so a spurious call can't un-dedup a live
   * child.
   */
  releaseFingerprint(fingerprint: string): void {
    if (this.findByFingerprint(fingerprint)) return;
    this.fingerprints.delete(fingerprint);
  }

  /** Remove a node's fingerprint from the live set (e.g. on cancel). */
  unregisterFingerprint(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (node?.briefHash) this.fingerprints.delete(node.briefHash);
  }

  get(nodeId: string): CallGraphNode | undefined {
    return this.nodes.get(nodeId);
  }

  /** Walk `node → parent → grandparent → …` (excludes the starting node). */
  *walkAncestors(startId: string | null): IterableIterator<CallGraphNode> {
    let cur = startId ? this.nodes.get(startId) : undefined;
    while (cur?.parentNodeId) {
      const parent = this.nodes.get(cur.parentNodeId);
      if (!parent) return;
      yield parent;
      cur = parent;
    }
  }

  /**
   * Has this node (typically an Agent) already consumed its one
   * per-lifetime escalation? Capped per design §Escalation.
   */
  hasEscalated(nodeId: string): boolean {
    return this.nodes.get(nodeId)?.escalationUsed === true;
  }

  /** Mark the escalation as used. Returns false if already used. */
  markEscalated(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    if (node.escalationUsed) return false;
    node.escalationUsed = true;
    return true;
  }

  snapshot(): CallGraphSnapshot {
    return {
      rootSessionId: this.rootSessionId,
      startedAt: this.startedAt,
      nodeCount: this.nodes.size,
      fingerprintCount: this.fingerprints.size,
    };
  }

  /** Drop everything; called by the registry on root complete. */
  clear(): void {
    this.nodes.clear();
    this.fingerprints.clear();
  }

  // ── internals ────────────────────────────────────────────────────
  private findByFingerprint(fp: string): CallGraphNode | undefined {
    for (const node of this.nodes.values()) {
      if (node.briefHash === fp) return node;
    }
    return undefined;
  }
}

// ── Registry (per rootSessionId) ──────────────────────────────────

const GRAPHS = new Map<string, SwarmCallGraph>();

/** Get (or create) the call graph for the given root session. */
export function getCallGraph(rootSessionId: string): SwarmCallGraph {
  let g = GRAPHS.get(rootSessionId);
  if (!g) {
    g = new SwarmCallGraph(rootSessionId);
    GRAPHS.set(rootSessionId, g);
  }
  return g;
}

/** Peek at the call graph if one exists. */
export function peekCallGraph(rootSessionId: string): SwarmCallGraph | undefined {
  return GRAPHS.get(rootSessionId);
}

/**
 * GC hook: drop the graph. Safe to call multiple times. Call on root agent
 * root completion / failure / cancellation.
 */
export function releaseCallGraph(rootSessionId: string): void {
  const g = GRAPHS.get(rootSessionId);
  if (!g) return;
  g.clear();
  GRAPHS.delete(rootSessionId);
}

/** Test-only: reset every graph. Do not call from production code. */
export function __resetCallGraphsForTests(): void {
  for (const g of GRAPHS.values()) g.clear();
  GRAPHS.clear();
}
