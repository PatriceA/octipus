import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { CommandRegistry, registerBuiltinCommands } from './commands';

describe('CommandRegistry', () => {
  let registry: CommandRegistry;
  // spyOn the session-repository methods (reset per test) rather than
  // `vi.mock()` the module, so each test sets exactly the rows it needs.
  const findByIdSpy = vi.spyOn(sessionRepository, 'findById');
  const updateSpy = vi.spyOn(sessionRepository, 'update');
  const clearSpy = vi.spyOn(sessionRepository, 'clearContext');

  beforeEach(() => {
    registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    findByIdSpy.mockReset();
    updateSpy.mockReset();
    clearSpy.mockReset();
    clearSpy.mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    findByIdSpy.mockReset();
    updateSpy.mockReset();
    clearSpy.mockReset();
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
    // The clear is one atomic repository statement now: it stamps clearedAt and
    // a fresh generation, drops the checkpoint/summary/vendor-session keys and
    // keeps everything else — all in SQL, so there is no context object to
    // assert on here. session-context-patch.test.ts proves it at the SQL level.
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledWith('sess-1');
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

  test('getAvailable hides admin-only commands from non-admins', () => {
    const userNames = registry.getAvailable(false).map(c => c.name);
    expect(userNames).toContain('help');
    expect(userNames).toContain('status');
    expect(userNames).not.toContain('reload-extensions');
    expect(registry.getAvailable(true).map(c => c.name)).toContain('reload-extensions');
  });

  test('custom command registration', async () => {
    registry.register({
      name: 'test',
      aliases: ['t'],
      description: 'Test command',
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
    const getLast = vi.spyOn(messageRepository, 'findRecentBySession');
    findById.mockResolvedValue({ id: 'sess-1', userId: '22222222-2222-4333-8444-555555555555' } as never);
    expect((await registry.execute('/history', ctx))!.text).toBe('Session not found.');
    findById.mockResolvedValue(null);
    expect((await registry.execute('/history', ctx))!.text).toBe('Session not found.');
    expect(getLast).not.toHaveBeenCalled();
  });

  test('/history replays user and assistant turns oldest first, skipping tool rows', async () => {
    const at = (s: number) => new Date(1_700_000_000_000 + s * 1000);
    vi.spyOn(sessionRepository, 'findById').mockResolvedValue({ id: 'sess-1', userId: user } as never);
    vi.spyOn(messageRepository, 'findRecentBySession').mockResolvedValue([
      { id: 'm1', role: 'user', content: 'hello', createdAt: at(0) },
      { id: 'm2', role: 'tool', content: '{"ok":true}', createdAt: at(1) },
      { id: 'm3', role: 'assistant', content: 'hi back', createdAt: at(2) },
    ] as never);
    const result = await registry.execute('/history', ctx);
    expect(result!.data).toEqual([
      { id: 'm1', role: 'user', content: 'hello', at: at(0).toISOString() },
      { id: 'm3', role: 'assistant', content: 'hi back', at: at(2).toISOString() },
    ]);
    expect(result!.text).toBe('❯ hello\n\n  hi back');
  });

  test('/history asks for visible user and assistant rows only: a companion\'s internal check-in is not replayed', async () => {
    vi.spyOn(sessionRepository, 'findById').mockResolvedValue({ id: 'sess-1', userId: user } as never);
    // Every row of the session, newest first — what an unfiltered read returns.
    vi.spyOn(messageRepository, 'getLastMessages').mockResolvedValue([
      { role: 'assistant', content: 'Internal briefing', createdAt: new Date(2), metadata: { visibility: 'internal' } },
      { role: 'user', content: 'hello', createdAt: new Date(1) },
    ] as never);
    const recent = vi.spyOn(messageRepository, 'findRecentBySession').mockResolvedValue([
      { role: 'user', content: 'hello', createdAt: new Date(1) },
    ] as never);
    const result = await registry.execute('/history', ctx);
    expect(recent).toHaveBeenCalledWith('sess-1', 50, ['user', 'assistant']);
    expect(JSON.stringify(result!.data)).not.toContain('Internal briefing');
  });

  test('/history without a session says so', async () => {
    const result = await registry.execute('/history', { ...ctx, sessionId: undefined });
    expect(result!.text).toBe('No active session.');
  });
});

// `/model <name>` resolves a row id first (database-backed); unresolved, it matches the caller's models by name.
vi.mock('@/models/resolve-model', () => ({ resolveModel: async () => null }));

describe('/model (the terminal\'s model picker)', () => {
  const user = '11111111-2222-4333-8444-555555555555';
  const ctx = { userId: user, sessionId: 'sess-model', clientType: 'tui', trustLevel: 'user' as const };
  let registry: CommandRegistry;
  beforeEach(async () => {
    registry = new CommandRegistry(); registerBuiltinCommands(registry);
    const { getModelRegistry } = await import('@/models/model-registry');
    vi.spyOn(getModelRegistry(), 'getModelsForUser').mockResolvedValue([
      { name: 'fast', modelId: 'small-1', provider: 'ollama', isEnabled: true, isDefault: true },
      { name: 'off', modelId: 'old-1', provider: 'ollama', isEnabled: false, isDefault: false },
      { name: 'deep', modelId: 'large-2', provider: 'openrouter', isEnabled: true, isDefault: false },
    ] as never);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    (await import('@/core/agent/session-model-override'))._resetSessionModelOverridesForTesting();
  });

  test('alone it says what is set and lists the enabled models the caller may use as data', async () => {
    const result = await registry.execute('/model', ctx);
    expect(result!.text).toContain('No session override set');
    expect(result!.data).toEqual({ current: null, models: [
      { name: 'fast', modelId: 'small-1', provider: 'ollama', isDefault: true },
      { name: 'deep', modelId: 'large-2', provider: 'openrouter', isDefault: false },
    ] });
  });

  test('with a name it sets the caller\'s override for the session, as the chat command does; clear drops it', async () => {
    const set = await registry.execute('/model deep', ctx);
    expect(set!.text).toContain('switched to `large-2`');
    expect(((await registry.execute('/model', ctx))!.data as { current: string }).current).toBe('deep');
    expect((await registry.execute('/model clear', ctx))!.text).toContain('override cleared');
    expect(((await registry.execute('/model', ctx))!.data as { current: string | null }).current).toBeNull();
  });
});
