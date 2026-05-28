import type { ToolHandler } from '@/core/agent-worker';
import type { AgentWorker } from '@/core/agent-worker';
import { swarmNodeRepository } from './node-repository';
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
          description: 'Max wait per child (default: half of the agent’s remaining wall-clock, max 120s).',
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
      const explicit = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
        ? Math.max(1_000, Math.min(args.timeoutMs, 600_000))
        : null;
      const wallStarted = parent.budget.wallClockMs.startedAt;
      const wallCap = parent.budget.wallClockMs.cap;
      const remaining = Math.max(0, wallCap - (Date.now() - wallStarted));
      const timeoutMs = explicit ?? Math.min(120_000, Math.max(15_000, Math.floor(remaining / 2)));

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
    const notes = r.notes ? `\n  <notes>${r.notes}</notes>` : '';
    return `<ChildResult ${meta}>\n  <output>${outStr}</output>${notes}\n</ChildResult>`;
  });
  return `<CollectChildren count="${results.length}">\n${lines.join('\n')}\n</CollectChildren>`;
}
