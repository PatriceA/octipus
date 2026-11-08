/**
 * What Mission control's "Started by" says: the entry point's ambient origin
 * reaches every agent spawned under it, a child is "spawned" whatever its
 * tree, and a turn with nothing more specific is named by its channel.
 */
import { describe, expect, test } from 'vitest';
import { getAmbientOrigin, resolveAgentOrigin, sourceForChannel, withAgentOrigin } from './agent-origin';

describe('sourceForChannel', () => {
  test.each([
    ['webchat', 'user', 'chat'], ['tui', 'user', 'chat'], ['api', 'user', 'chat'],
    ['slack', 'user', 'channel'], ['telegram', 'user', 'channel'],
    ['heartbeat', 'schedule', 'heartbeat'], ['hook', 'schedule', 'schedule'], ['cron', 'schedule', 'schedule'],
    ['monitor', 'monitor', 'monitor'], ['room', 'room', 'room'], [undefined, 'schedule', 'schedule'],
  ] as const)('%s / %s → %s', (channel, trigger, source) => {
    expect(sourceForChannel(channel, trigger)).toBe(source);
  });
});

describe('resolveAgentOrigin', () => {
  test('a child is spawned, and keeps the hook its tree started from', () => {
    expect(resolveAgentOrigin({ parentAgentId: 'root-1', trigger: 'schedule', channel: 'heartbeat', ambient: { source: 'heartbeat', hookId: 'h1', hookName: 'writer' } }))
      .toEqual({ source: 'spawned', channel: 'heartbeat', hookId: 'h1', hookName: 'writer' });
  });

  test('an explicit ambient source wins over the channel; a pipeline or goal over the channel', () => {
    expect(resolveAgentOrigin({ trigger: 'user', channel: 'webchat', ambient: { source: 'webhook' } }).source).toBe('webhook');
    expect(resolveAgentOrigin({ trigger: 'user', channel: 'webchat', ambient: { pipelineId: 'p1' } })).toEqual({ source: 'pipeline', channel: 'webchat', pipelineId: 'p1' });
    expect(resolveAgentOrigin({ trigger: 'monitor', channel: 'monitor', ambient: { goalId: 'g1' } }).source).toBe('companion');
    expect(resolveAgentOrigin({ trigger: 'user' })).toEqual({ source: 'chat' });
  });
});

test('the ambient origin crosses awaits and nests by merging', async () => {
  const seen = await withAgentOrigin({ source: 'companion', goalId: 'g1' }, async () => {
    await new Promise((r) => setTimeout(r, 1));
    return withAgentOrigin({ pipelineId: 'p1' }, async () => getAmbientOrigin());
  });
  expect(seen).toEqual({ source: 'companion', goalId: 'g1', pipelineId: 'p1' });
  expect(getAmbientOrigin()).toBeUndefined();
});
