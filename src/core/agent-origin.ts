/**
 * Who started an agent (docs/MISSION-CONTROL.md).
 *
 * `AgentTrigger` (user/room/schedule/monitor/…) is the scope decision — who
 * may be prompted, who pays — and it is too coarse to tell a heartbeat from a
 * cron hook from a webhook. The entry points that know more (the hook runner,
 * the Companion dispatcher, the pipeline runner) set an ambient origin around
 * the work they start; every agent spawned underneath, however deep, records
 * it, and `resolveAgentOrigin` fills in what the spawn itself knows (a
 * parent: spawned; a channel: chat, messaging, room…).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentTrigger } from '@/core/types';
import type { AgentOrigin, AgentSource } from '@/shared/agent-origin';

type AmbientOrigin = Partial<AgentOrigin>;

const storage = new AsyncLocalStorage<AmbientOrigin>();

/** Run `fn` with `origin` merged over the current ambient origin. */
export function withAgentOrigin<T>(origin: AmbientOrigin, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...origin }, fn);
}

export function getAmbientOrigin(): AmbientOrigin | undefined {
  return storage.getStore();
}

const MESSAGING_CHANNELS = new Set(['telegram', 'slack', 'teams', 'whatsapp']);

/** The source a turn entering through `channel` gets when nothing more specific is known. */
export function sourceForChannel(channel: string | undefined, trigger: AgentTrigger): AgentSource {
  if (channel === 'heartbeat') return 'heartbeat';
  if (channel === 'hook' || channel === 'cron') return 'schedule';
  if (channel === 'monitor') return 'monitor';
  if (channel === 'room' || channel === 'remote-room' || trigger === 'room' || trigger === 'listen') return 'room';
  if (channel && MESSAGING_CHANNELS.has(channel)) return 'channel';
  if (trigger === 'schedule') return 'schedule';
  if (trigger === 'monitor') return 'monitor';
  return 'chat';
}

/**
 * The origin recorded for a new agent. A child of another agent is
 * `spawned` whatever started its tree (the tree's origin stays in the other
 * fields: the hook, the pipeline); otherwise the most specific of: the
 * ambient source, a pipeline, a Companion goal, the turn's channel.
 */
export function resolveAgentOrigin(input: {
  parentAgentId?: string;
  trigger: AgentTrigger;
  channel?: string;
  ambient?: AmbientOrigin;
}): AgentOrigin {
  const ambient = input.ambient ?? {};
  const channel = ambient.channel ?? input.channel;
  const source: AgentSource = input.parentAgentId
    ? 'spawned'
    : ambient.source
      ?? (ambient.pipelineId ? 'pipeline' : ambient.goalId ? 'companion' : sourceForChannel(channel, input.trigger));
  return {
    source,
    ...(channel ? { channel } : {}),
    ...(ambient.hookId ? { hookId: ambient.hookId } : {}),
    ...(ambient.hookName ? { hookName: ambient.hookName } : {}),
    ...(ambient.pipelineId ? { pipelineId: ambient.pipelineId } : {}),
    ...(ambient.goalId ? { goalId: ambient.goalId } : {}),
  };
}
