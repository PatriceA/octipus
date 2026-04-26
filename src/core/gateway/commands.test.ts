import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { CommandRegistry, registerBuiltinCommands } from './commands';

describe('CommandRegistry', () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    registry = new CommandRegistry();
    registerBuiltinCommands(registry);
  });

  test('executes /help command', async () => {
    const result = await registry.execute('/help', {
      userId: 'user1',
      sessionId: 'session1',
      clientType: 'webchat',
      trustLevel: 'user',
    });
    expect(result).not.toBeNull();
    expect(result!.text).toContain('Available commands');
    expect(result!.text).toContain('/help');
    expect(result!.text).toContain('/status');
  });

  test('executes /status command', async () => {
    const result = await registry.execute('/status', {
      userId: 'user1',
      sessionId: 'session1',
      clientType: 'webchat',
      trustLevel: 'user',
    });
    expect(result).not.toBeNull();
    expect(result!.text).toContain('Session:');
  });

  test('alias /h works for /help', async () => {
    const result = await registry.execute('/h', {
      userId: 'user1',
      clientType: 'webchat',
      trustLevel: 'user',
    });
    expect(result).not.toBeNull();
    expect(result!.text).toContain('Available commands');
  });

  test('alias /? works for /help', async () => {
    const result = await registry.execute('/?', {
      userId: 'user1',
      clientType: 'webchat',
      trustLevel: 'user',
    });
    expect(result).not.toBeNull();
    expect(result!.text).toContain('Available commands');
  });

  test('returns null for non-command input', async () => {
    const result = await registry.execute('hello world', {
      userId: 'user1',
      clientType: 'webchat',
      trustLevel: 'user',
    });
    expect(result).toBeNull();
  });

  test('returns error for unknown command', async () => {
    const result = await registry.execute('/nonexistent', {
      userId: 'user1',
      clientType: 'webchat',
      trustLevel: 'user',
    });
    expect(result).not.toBeNull();
    expect(result!.text).toContain('Unknown command');
  });

  test('/clear without session returns no-session message', async () => {
    const result = await registry.execute('/clear', {
      userId: 'user1',
      clientType: 'webchat',
      trustLevel: 'user',
    });
    expect(result!.text).toBe('No active session.');
  });

  test('/clear with webchat session sets clearedAt and returns [clear] signal', async () => {
    const updateMock = mock(async () => undefined);
    const findByIdMock = mock(async () => ({
      id: 'sess-1',
      userId: 'user1',
      context: { lastTopic: 'coding' },
    }));
    mock.module('@/db/repositories/session-repository', () => ({
      sessionRepository: { findById: findByIdMock, update: updateMock },
    }));

    const result = await registry.execute('/clear', {
      userId: 'user1',
      sessionId: 'sess-1',
      clientType: 'webchat',
      trustLevel: 'user',
    });

    expect(result!.text).toBe('[clear]');
    expect(updateMock).toHaveBeenCalledTimes(1);
    const updateCall = updateMock.mock.calls[0] as unknown as [string, { context: Record<string, unknown> }];
    expect(updateCall[0]).toBe('sess-1');
    expect(typeof updateCall[1].context.clearedAt).toBe('string');
    // ISO-8601 round-trip — invalid string would NaN on Date parse.
    expect(Number.isNaN(new Date(updateCall[1].context.clearedAt as string).getTime())).toBe(false);
    // Pre-existing context survives (we merge, not replace).
    expect(updateCall[1].context.lastTopic).toBe('coding');
    // Compacted summary is wiped so the orchestrator doesn't pull stale context.
    expect(updateCall[1].context.compactedSummary).toBeUndefined();
  });

  test('/clear preserves transcript on persistent channels (telegram/slack/etc)', async () => {
    const updateMock = mock(async () => undefined);
    const findByIdMock = mock(async () => ({
      id: 'sess-tg',
      userId: 'user1',
      context: {},
    }));
    mock.module('@/db/repositories/session-repository', () => ({
      sessionRepository: { findById: findByIdMock, update: updateMock },
    }));

    for (const clientType of ['telegram', 'slack', 'whatsapp', 'teams']) {
      const result = await registry.execute('/clear', {
        userId: 'user1',
        sessionId: 'sess-tg',
        clientType,
        trustLevel: 'user',
      });
      expect(result!.text).not.toBe('[clear]');
      expect(result!.text).toMatch(/start fresh|context reset|past messages/i);
    }
  });

  test('/clear aliases /cls and /reset both work', async () => {
    const updateMock = mock(async () => undefined);
    const findByIdMock = mock(async () => ({ id: 'sess-1', userId: 'user1', context: {} }));
    mock.module('@/db/repositories/session-repository', () => ({
      sessionRepository: { findById: findByIdMock, update: updateMock },
    }));

    for (const cmd of ['/cls', '/reset']) {
      const result = await registry.execute(cmd, {
        userId: 'user1',
        sessionId: 'sess-1',
        clientType: 'webchat',
        trustLevel: 'user',
      });
      expect(result!.text).toBe('[clear]');
    }
  });

  test('/compact with no session returns message', async () => {
    const result = await registry.execute('/compact', {
      userId: 'user1',
      clientType: 'webchat',
      trustLevel: 'user',
    });
    expect(result!.text).toContain('No active session');
  });

  test('getAvailable filters by trust level', () => {
    const userCmds = registry.getAvailable('user');
    const allNames = userCmds.map(c => c.name);
    expect(allNames).toContain('help');
    expect(allNames).toContain('status');
    expect(allNames).toContain('expert');
  });

  test('custom command registration', async () => {
    registry.register({
      name: 'test',
      aliases: ['t'],
      description: 'Test command',
      minTrustLevel: 'user',
      handler: async (ctx) => ({ text: `Hello ${ctx.args.name || 'world'}` }),
      args: [{ name: 'name', required: false, description: 'Name' }],
    });

    const result = await registry.execute('/test Alice', {
      userId: 'user1',
      clientType: 'webchat',
      trustLevel: 'user',
    });
    expect(result!.text).toBe('Hello Alice');
  });
});
