import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { CommandRegistry, registerBuiltinCommands } from './commands';

describe('CommandRegistry', () => {
  let registry: CommandRegistry;
  // Use spyOn (auto-restores) instead of `vi.mock()` for the
  // session-repository fakes — bun's `mock.module` is process-wide and
  // would leak hard-coded `{id:'sess-1',userId:'user1'}` into every later
  // test (notably the swarm/agents integration tests whose
  // canAccessRootSession would always reject under that mock).
  const findByIdSpy = vi.spyOn(sessionRepository, 'findById');
  const updateSpy = vi.spyOn(sessionRepository, 'update');

  beforeEach(() => {
    registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    findByIdSpy.mockReset();
    updateSpy.mockReset();
  });

  afterEach(() => {
    findByIdSpy.mockReset();
    updateSpy.mockReset();
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

  test('/changes on a non-git workspace reports not-a-repo', async () => {
    // A real user id maps to a per-user workspace that doesn't exist on disk in
    // the test env, so it is never a git repo — deterministic not-a-repo path.
    const result = await registry.execute('/changes', {
      userId: 'user-without-workspace',
      clientType: 'tui',
      trustLevel: 'user',
    });
    expect(result).not.toBeNull();
    expect(result!.text).toContain('Not a git repository');
  });

  test('/changes is listed in /help', async () => {
    const result = await registry.execute('/help', {
      userId: 'user1',
      clientType: 'tui',
      trustLevel: 'user',
    });
    expect(result!.text).toContain('/changes');
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
    findByIdSpy.mockResolvedValue({
      id: 'sess-1',
      userId: 'user1',
      context: { lastTopic: 'coding' },
    } as never);
    updateSpy.mockResolvedValue(undefined as never);

    const result = await registry.execute('/clear', {
      userId: 'user1',
      sessionId: 'sess-1',
      clientType: 'webchat',
      trustLevel: 'user',
    });

    expect(result!.text).toBe('[clear]');
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const updateCall = updateSpy.mock.calls[0] as unknown as [string, { context: Record<string, unknown> }];
    expect(updateCall[0]).toBe('sess-1');
    expect(typeof updateCall[1].context.clearedAt).toBe('string');
    // ISO-8601 round-trip — invalid string would NaN on Date parse.
    expect(Number.isNaN(new Date(updateCall[1].context.clearedAt as string).getTime())).toBe(false);
    // Pre-existing context survives (we merge, not replace).
    expect(updateCall[1].context.lastTopic).toBe('coding');
    // Compacted summary is wiped so the root agent doesn't pull stale context.
    expect(updateCall[1].context.compactedSummary).toBeUndefined();
  });

  test('/clear preserves transcript on persistent channels (telegram/slack/etc)', async () => {
    findByIdSpy.mockResolvedValue({
      id: 'sess-tg',
      userId: 'user1',
      context: {},
    } as never);
    updateSpy.mockResolvedValue(undefined as never);

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
    findByIdSpy.mockResolvedValue({ id: 'sess-1', userId: 'user1', context: {} } as never);
    updateSpy.mockResolvedValue(undefined as never);

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

describe('/sessions and /history (TUI resume)', () => {
  const user = '11111111-2222-4333-8444-555555555555';
  const ctx = { userId: user, sessionId: 'sess-1', clientType: 'tui', trustLevel: 'user' as const };
  let registry: CommandRegistry;
  beforeEach(() => { registry = new CommandRegistry(); registerBuiltinCommands(registry); });
  afterEach(() => { vi.restoreAllMocks(); });

  test('/sessions labels a generically titled session with its first question and returns data', async () => {
    const updatedAt = new Date('2026-09-11T10:00:00Z');
    vi.spyOn(sessionRepository, 'listByUser').mockResolvedValue([
      { id: 'aaaaaaaa-0000-4000-8000-000000000000', title: 'tui conversation', channelType: 'tui', messageCount: 4, updatedAt },
      { id: 'bbbbbbbb-0000-4000-8000-000000000000', title: 'Named one', channelType: 'webchat', messageCount: 1, updatedAt },
    ] as never);
    vi.spyOn(messageRepository, 'findBySession').mockResolvedValue([{ content: '  what is   the weather\nin Berlin?' }] as never);
    const result = await registry.execute('/sessions', ctx);
    expect(result!.text).toContain(' 1  aaaaaaaa  2026-09-11 10:00    4 msg  what is the weather in Berlin?');
    expect(result!.text).toContain('Named one');
    expect(result!.data).toMatchObject([{ id: 'aaaaaaaa-0000-4000-8000-000000000000', title: 'what is the weather in Berlin?' }, { title: 'Named one' }]);
  });

  test('/history refuses another user\'s session and an unknown one alike', async () => {
    const findById = vi.spyOn(sessionRepository, 'findById');
    const getLast = vi.spyOn(messageRepository, 'getLastMessages');
    findById.mockResolvedValue({ id: 'sess-1', userId: '22222222-2222-4333-8444-555555555555' } as never);
    expect((await registry.execute('/history', ctx))!.text).toBe('Session not found.');
    findById.mockResolvedValue(null);
    expect((await registry.execute('/history', ctx))!.text).toBe('Session not found.');
    expect(getLast).not.toHaveBeenCalled();
  });

  test('/history replays user and assistant turns oldest first, skipping tool rows', async () => {
    const at = (s: number) => new Date(1_700_000_000_000 + s * 1000);
    vi.spyOn(sessionRepository, 'findById').mockResolvedValue({ id: 'sess-1', userId: user } as never);
    vi.spyOn(messageRepository, 'getLastMessages').mockResolvedValue([
      { role: 'assistant', content: 'hi back', createdAt: at(2) },
      { role: 'tool', content: '{"ok":true}', createdAt: at(1) },
      { role: 'user', content: 'hello', createdAt: at(0) },
    ] as never);
    const result = await registry.execute('/history', ctx);
    expect(result!.data).toEqual([
      { role: 'user', content: 'hello', at: at(0).toISOString() },
      { role: 'assistant', content: 'hi back', at: at(2).toISOString() },
    ]);
    expect(result!.text).toBe('❯ hello\n\n  hi back');
  });

  test('/history without a session says so', async () => {
    const result = await registry.execute('/history', { ...ctx, sessionId: undefined });
    expect(result!.text).toBe('No active session.');
  });
});
