import type { ToolHandler } from '@/core/agent-worker';
import type { AgentWorker } from '@/core/agent-worker';
import { swarmNodeRepository } from './node-repository';
import { getLevelDefault } from './types';
import type { AgentNode, ChildResult } from './types';

/**
 * `collect_children` — agent-depth (1) tool for picking up the results of
 * detached subagents spawned earlier in this turn.
 *
 * Default: wait for ALL still-pending detached children on this worker.
 * With `childIds`: wait only for the named ones (useful when the agent
 * wants partial results and plans to poll again later).
 *
 * Results are returned as entries (not thrown) — a failed detached child
 * surfaces as `{ status: 'tool_error'|'timeout', notes: '...' }` so the
 * parent can still synthesize with the good ones.
 *
 * Persistence: on collect we flip `swarm_nodes.collected_at = now()` so
 * the orphan reaper can tell detached children whose parent forgot them
 * apart from ones the parent picked up cleanly.
 */
export function createCollectChildrenTool(
  parent: AgentNode,
  workerRef: { current: AgentWorker | null },
): ToolHandler {
  return {
    name: 'collect_children',
    final: false,
    description:
      'Pick up the results of subagents you spawned with `spawn_child` mode="detach". ' +
      'Default: waits for ALL pending detached children on this turn and returns them as an array. ' +
      'Call this BEFORE your final answer — otherwise the framework auto-collects (with a hard timeout) ' +
      'and you may finalize without seeing the data. Failures surface as entries, not thrown exceptions.',
    previewParam: 'timeoutMs',
    parameters: {
      type: 'object',
      properties: {
        timeoutMs: {
          type: 'number',
          description: 'Max wait per child (default: the child’s wall budget, bounded by the agent’s remaining wall-clock).',
        },
      },
    },
    execute: async (args) => {
      const worker = workerRef.current;
      if (!worker) {
        return 'collect_children: internal error — worker not wired for this parent.';
      }
      const pending = worker.listPendingDetached();
      if (pending.length === 0) {
        return 'collect_children: no detached children pending. Nothing to collect.';
      }

      // Resolve timeout: either explicit override, or half the remaining
      // wall budget of the parent (computed from node budget, clamped).
      // Floor an explicit override at 15s. A trivially short poll (e.g. 5s) on a
      // child still doing real work (a phone call polls for ~minutes) comes back
      // status="timeout", which weak orchestrators misread as failure and answer
      // by spawning duplicate retry children. 15s matches the non-explicit floor.
      const explicit = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
        ? Math.max(15_000, Math.min(args.timeoutMs, 600_000))
        : null;
      const wallStarted = parent.budget.wallClockMs.startedAt;
      const wallCap = parent.budget.wallClockMs.cap;
      const remaining = Math.max(0, wallCap - (Date.now() - wallStarted));
      // A detached child can run up to its own wall budget
      // (`getLevelDefault(1).wallMs` — 10 min by default). Waiting less than
      // that — the old 120s clamp — reported a still-working child as
      // `timeout`/null and dropped its result. Wait up to the child wall
      // (+margin), bounded by the parent's own remaining wall so we don't
      // overrun the parent's budget.
      const childWall = getLevelDefault(1).wallMs;
      const target = childWall + 5_000;
      // Clamp an explicit timeout to the parent's own remaining wall so the 15s
      // floor above can't force a near-budget caller to block past its deadline
      // and trip the hard agent-timeout instead of returning STILL RUNNING.
      const timeoutMs = explicit != null
        ? (remaining > 0 ? Math.min(explicit, remaining) : explicit)
        : Math.max(15_000, remaining > 0 ? Math.min(remaining, target) : target);

      const results = await worker.collectAllDetached(timeoutMs);

      // Mark the DB rows as collected so the orphan reaper doesn't flag them.
      for (const result of results) {
        if (result.status === 'timeout') continue; // still running; don't mark
        try {
          await swarmNodeRepository.markCollected(result.nodeId);
        } catch {
          /* best-effort — reaper has a safety net */
        }
      }

      return formatCollectedResults(results);
    },
  };
}

export function formatCollectedResults(results: ChildResult[]): string {
  if (results.length === 0) return '<CollectChildren count="0" />';
  const lines = results.map((r) => {
    const outStr =
      typeof r.output === 'string' ? r.output : JSON.stringify(r.output);
    const meta =
      `nodeId="${r.nodeId}" status="${r.status}" ` +
      `tokens="${r.usedTokens}" durationMs="${r.durationMs}"`;
    // A collect-path timeout (the wait elapsed, `notes` = "collect_children
    // timeout after Xms" from detached-child-manager) means the child is STILL
    // RUNNING, not failed — say so loudly, because a weak orchestrator otherwise
    // reads status="timeout" as failure and answers by spawning duplicate retry
    // children. A child that exhausted its OWN wall budget is terminal and keeps
    // its own notes, so gate on the collect-timeout signature specifically.
    const stillRunning = r.status === 'timeout' && /collect_children timeout/i.test(r.notes ?? '');
    const notes = stillRunning
      ? '\n  <notes>STILL RUNNING — did not finish within the wait window; it was NOT cancelled and is still working. Do NOT spawn a retry or duplicate child. Call collect_children again to keep waiting for it.</notes>'
      : r.notes ? `\n  <notes>${r.notes}</notes>` : '';
    // Mirror the await-path surface (formatChildResult): make a failed scorer
    // gate explicit so a detached contract_failed child isn't overlooked.
    const scorerFail =
      r.scorerOutcome && !r.scorerOutcome.passed
        ? `\n  <scorers passed="false">${r.scorerOutcome.failures
            .map((f) => `${f.scorer}: ${f.reason}`)
            .join('; ')}</scorers>`
        : '';
    return `<ChildResult ${meta}>\n  <output>${outStr}</output>${notes}${scorerFail}\n</ChildResult>`;
  });
  return `<CollectChildren count="${results.length}">\n${lines.join('\n')}\n</CollectChildren>`;
}
