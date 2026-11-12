/**
 * `list_lanes` — read-only view of the model lanes a delegating agent can
 * send a child to: each lane's primary, backup and executor binding as the
 * requester resolves them, and whether each is usable right now.
 *
 * Visibility, not choice. Lanes are admin-bound (`core/agent/lane-intent.ts`);
 * this exists so an agent can pick the right `topic` for `spawn_child` and
 * explain a refusal, not so it can route around a binding.
 */
import type { ToolHandler } from '@/core/agent-worker';
import { resolveModel } from '@/models/resolve-model';
import { getTopicConfig } from '@/models/topic-config';
import { LANES } from '@/core/agent/lane-intent';
import { checkModelAvailability, describeModel } from './lane-availability';

type Row = { modelId: string; name: string; provider?: string | null } | null;

async function show(row: Row): Promise<string> {
  if (!row) return 'none';
  const health = await checkModelAvailability(row);
  return `${describeModel(row)} — ${health.available ? 'available' : `unavailable: ${health.reason}`}`;
}

export function createListLanesTool(): ToolHandler {
  return {
    name: 'list_lanes',
    discoverOnly: true,
    replaySafety: 'read_only',
    description:
      'Read-only: the model lanes spawn_child can use (build, verify, everyday, research), each with its bound primary, ' +
      'backup and executor model and whether each is available now. Lanes are set by the user; you cannot change them. ' +
      'Use it to choose spawn_child topic, or to explain why a lane is unavailable.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, context) => {
      const scope = { userId: context.userId, inSpace: !!context.space, spaceRole: context.space?.role, sponsor: context.sponsor ?? null };
      const lines = await Promise.all(LANES.map(async (lane) => {
        const [primary, backup] = await Promise.all([
          resolveModel({ ...scope, topic: lane }).catch(() => null),
          resolveModel({ ...scope, topic: lane, backup: true }).catch(() => null),
        ]);
        const executorName = getTopicConfig(lane).executorModel;
        const executor = executorName ? await resolveModel({ ...scope, name: executorName }).catch(() => null) : null;
        const [p, b, e] = await Promise.all([show(primary), show(backup), executor ? show(executor) : null]);
        return [
          `${lane}:`,
          `  primary: ${p}`,
          `  backup: ${b}`,
          `  executor (planned children): ${executorName ? (e ?? `${executorName} — not registered or not visible to you`) : 'none (primary runs planned children)'}`,
        ].join('\n');
      }));
      return lines.join('\n');
    },
  };
}
