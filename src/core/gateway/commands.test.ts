import { describe, test, expect, beforeEach } from 'bun:test';
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
