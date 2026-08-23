import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GatewayEventBus } from '@/core/gateway/event-bus';
import { getCommandRegistry } from '@/core/gateway/commands';
import type { GatewayEvent } from '@/core/gateway/protocol';
import { buildExtensionContext } from './api';

function event(partial: Partial<GatewayEvent> = {}): GatewayEvent {
  return {
    id: partial.id ?? 'test-id',
    type: partial.type ?? 'test.event',
    source: partial.source ?? 'test',
    sessionId: partial.sessionId,
    userId: partial.userId,
    timestamp: partial.timestamp ?? Date.now(),
    payload: partial.payload ?? {},
  } as GatewayEvent;
}

describe('Extension API (factory + dispose)', () => {
  let bus: GatewayEventBus;

  beforeEach(() => {
    bus = new GatewayEventBus();
  });

  afterEach(async () => {
    bus.destroy();
  });

  test('on() filters events by pattern with wildcard support', async () => {
    const { api, loaded } = buildExtensionContext('test-ext', '/fake/path.ts', bus);

    const seen: string[] = [];
    api.on('chat.*', (e) => { seen.push(e.type); });

    bus.publish(event({ type: 'chat.message' }));
    bus.publish(event({ type: 'agent.spawned' }));
    bus.publish(event({ type: 'chat.response' }));

    // Allow microtask queue to drain (handlers are async-wrapped)
    await new Promise(r => setImmediate(r));

    expect(seen).toEqual(['chat.message', 'chat.response']);
    await loaded.dispose();
  });

  test('on() handler exceptions do not propagate to publisher', async () => {
    const { api, loaded } = buildExtensionContext('boom-ext', '/fake/path.ts', bus);
    api.on('test.event', () => { throw new Error('handler exploded'); });

    // Must not throw
    expect(() => bus.publish(event())).not.toThrow();

    await new Promise(r => setImmediate(r));
    await loaded.dispose();
  });

  test('dispose() unsubscribes all handlers', async () => {
    const { api, loaded } = buildExtensionContext('disp-ext', '/fake/path.ts', bus);

    const seen: string[] = [];
    api.on('test.event', (e) => { seen.push(e.id); });

    bus.publish(event({ id: 'before' }));
    await new Promise(r => setImmediate(r));
    expect(seen).toEqual(['before']);

    await loaded.dispose();

    bus.publish(event({ id: 'after' }));
    await new Promise(r => setImmediate(r));
    expect(seen).toEqual(['before']);
  });

  test('registerCommand wires through the command registry; dispose unregisters', async () => {
    const { api, loaded } = buildExtensionContext('cmd-ext', '/fake/path.ts', bus);

    api.registerCommand({
      name: 'extensiontest',
      description: 'just a test',
      handler: async () => ({ text: 'ok from extension' }),
    });

    const cmdRegistry = getCommandRegistry();
    let result = await cmdRegistry.execute('/extensiontest', {
      userId: 'u', sessionId: 's', clientType: 'tui', trustLevel: 'user',
    });
    expect(result?.text).toBe('ok from extension');

    await loaded.dispose();

    result = await cmdRegistry.execute('/extensiontest', {
      userId: 'u', sessionId: 's', clientType: 'tui', trustLevel: 'user',
    });
    expect(result?.text).toContain('Unknown command');
  });

  test('registerCommand catches handler exceptions and surfaces a friendly error', async () => {
    const { api, loaded } = buildExtensionContext('throwy-ext', '/fake/path.ts', bus);

    api.registerCommand({
      name: 'extthrow',
      description: 'boom',
      handler: async () => { throw new Error('nope'); },
    });

    const cmdRegistry = getCommandRegistry();
    const result = await cmdRegistry.execute('/extthrow', {
      userId: 'u', sessionId: 's', clientType: 'tui', trustLevel: 'user',
    });
    expect(result?.text).toContain('Error in /extthrow');
    expect(result?.text).toContain('nope');

    await loaded.dispose();
  });

  test('notify() publishes an extension.notify event', async () => {
    const { api, loaded } = buildExtensionContext('notify-ext', '/fake/path.ts', bus);

    const captured: GatewayEvent[] = [];
    bus.subscribe('extension.notify', (e) => { captured.push(e); });

    api.notify('hello world', 'warn', 'sess-1');

    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe('extension.notify');
    expect(captured[0].source).toBe('extension:notify-ext');
    expect(captured[0].sessionId).toBe('sess-1');
    expect((captured[0].payload as { message: string }).message).toBe('hello world');
    expect((captured[0].payload as { level: string }).level).toBe('warn');

    await loaded.dispose();
  });

  test('onDispose callbacks fire on dispose, even if one throws', async () => {
    const { api, loaded } = buildExtensionContext('teardown-ext', '/fake/path.ts', bus);

    const calls: string[] = [];
    api.onDispose(() => { calls.push('a'); });
    api.onDispose(() => { throw new Error('teardown boom'); });
    api.onDispose(async () => { calls.push('c'); });

    await loaded.dispose();
    expect(calls).toEqual(['a', 'c']);
  });

  test('after dispose, on() is a no-op', async () => {
    const { api, loaded } = buildExtensionContext('late-ext', '/fake/path.ts', bus);
    await loaded.dispose();

    const seen: string[] = [];
    api.on('test.event', (e) => { seen.push(e.id); });
    bus.publish(event({ id: 'late' }));
    await new Promise(r => setImmediate(r));
    expect(seen).toEqual([]);
  });
});
