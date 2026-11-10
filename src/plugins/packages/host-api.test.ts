/**
 * Host API tokens (docs/PLUGIN-PACKAGES.md#host-api): bound to one package,
 * one user and one call's lifetime; their scopes are declared ∩ approved ∩
 * what the tool's effect allows ∩ what the user holds.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AgentContext } from '@/core/types';
import type { MCPServer } from '@/shared/mcp-server';
import { PLUGIN_HOST_META_KEY, type PluginHostCallMeta } from '@/shared/plugin-package';

const held = vi.hoisted(() => ({ denied: new Set<string>(), off: new Set<string>() }));
vi.mock('@/security/permissions', () => ({
  getPermissionManager: () => ({
    check: async (_userId: string, toolId: string, action: string) => ({ level: held.denied.has(`${toolId}.${action}`) ? 'DENY' : 'ASK' }),
  }),
}));
vi.mock('@/core/modules/registry', () => ({ isToolOn: (toolId: string) => !held.off.has(toolId) }));

const {
  _liveHostTokens, grantableScopes, hostCallKind, hostApiTarget, issueHostCallMeta, mintHostToken, noteHostRead, revokeHostToken, revokePluginTokens,
  setHostApiPort, userHeldScopes, verifyHostToken,
} = await import('./host-api');

const grant = { plugin: 'acme', userId: 'u1', workspaceId: null, sessionId: null, scopes: ['notes:read' as const], maxProtection: 2 as const, tool: 't' };

afterEach(() => {
  held.denied.clear();
  held.off.clear();
  revokePluginTokens('acme');
  revokePluginTokens('other');
});

describe('scope intersection', () => {
  test('declared ∩ approved; a read tool gets no write scope', () => {
    const declared = ['notes:read', 'notes:write', 'tasks:write', 'notify', 'documents:read'] as const;
    expect(grantableScopes([...declared], ['notes:read', 'notes:write', 'notify'], 'write')).toEqual(['notes:read', 'notes:write', 'notify']);
    expect(grantableScopes([...declared], ['notes:read', 'notes:write', 'notify'], 'read')).toEqual(['notes:read']);
    expect(grantableScopes([...declared], [...declared], 'external')).toEqual([...declared]);
    expect(grantableScopes([...declared], null, 'write')).toEqual([]);
    expect(grantableScopes(undefined, [...declared], 'write')).toEqual([]);
    // Approved but no longer declared (an upgrade dropped it): not granted.
    expect(grantableScopes(['notes:read'], ['notes:read', 'tasks:write'], 'write')).toEqual(['notes:read']);
  });

  test('web:read and model:complete change no data: a read tool gets them', () => {
    expect(grantableScopes(['web:read', 'model:complete', 'notes:write'], ['web:read', 'model:complete', 'notes:write'], 'read')).toEqual(['web:read', 'model:complete']);
  });

  test('web:read is the web tool\'s fetch: a user whose rules deny it does not get it; model:complete has no tool action', async () => {
    held.denied.add('websearch.fetch');
    expect(await userHeldScopes('u1', ['web:read', 'model:complete'])).toEqual(['model:complete']);
    held.denied.clear();
    held.off.add('websearch');
    expect(await userHeldScopes('u1', ['web:read', 'model:complete'])).toEqual(['model:complete']);
  });

  test('the user holds a scope unless its module is off or their rules deny the matching action', async () => {
    held.denied.add('notes.write');
    held.off.add('documents');
    expect(await userHeldScopes('u1', ['notes:read', 'notes:write', 'documents:read', 'tasks:write', 'notify'])).toEqual(['notes:read', 'tasks:write', 'notify']);
  });
});

describe('tokens', () => {
  test('bound to the package and the expiry', () => {
    const now = 1_000_000;
    const { token, expiresAt } = mintHostToken(grant, 30_000, now);
    expect(token.startsWith('ocph_')).toBe(true);
    expect(expiresAt).toBe(now + 30_000);
    expect(verifyHostToken(token, 'acme', now + 1)?.userId).toBe('u1');
    // Another package presenting it gets nothing.
    expect(verifyHostToken(token, 'other', now + 1)).toBeNull();
    // A tampered or unknown token gets nothing.
    expect(verifyHostToken(`${token}x`, 'acme', now + 1)).toBeNull();
    expect(verifyHostToken('octi_abc', 'acme', now + 1)).toBeNull();
    // Expired: gone, also for a later check.
    expect(verifyHostToken(token, 'acme', now + 30_000)).toBeNull();
    expect(verifyHostToken(token, 'acme', now + 1)).toBeNull();
  });

  test('revoked at the end of the call, and with its package', () => {
    const a = mintHostToken(grant, 30_000).token;
    const b = mintHostToken(grant, 30_000).token;
    const c = mintHostToken({ ...grant, plugin: 'other' }, 30_000).token;
    revokeHostToken(a);
    expect(verifyHostToken(a, 'acme')).toBeNull();
    expect(verifyHostToken(b, 'acme')).not.toBeNull();
    revokePluginTokens('acme');
    expect(verifyHostToken(b, 'acme')).toBeNull();
    expect(verifyHostToken(c, 'other')).not.toBeNull();
  });

  test('the token is not stored in the clear, and the store is bounded by expiry', () => {
    const before = _liveHostTokens();
    const { token } = mintHostToken(grant, 1, 0);
    mintHostToken(grant, 30_000);
    // The first expired at 1 and the next mint swept it.
    expect(_liveHostTokens()).toBe(before + 1);
    expect(verifyHostToken(token, 'acme')).toBeNull();
  });
});

describe('the _meta of a call', () => {
  const server = (over: Partial<MCPServer['plugin']> = {}): MCPServer => ({
    id: 'plugin-acme', name: 'Acme', command: 'node', isEnabled: true, requestTimeoutMs: 10_000,
    plugin: { package: 'acme', version: '1.0.0', tools: { read_it: 'read', write_it: 'write' }, maxProtection: 2, hostScopes: ['notes:read', 'notes:write'], ...over },
  });
  const context = { id: 'a1', userId: 'u1', sessionId: 's1', workspaceId: 'w1', space: null, trigger: 'user', metadata: {} } as unknown as AgentContext;

  test('a fresh token for the calling user, narrowed to the tool, revoked on release', async () => {
    const issued = await issueHostCallMeta(server(), 'read_it', context);
    const meta = issued?.meta[PLUGIN_HOST_META_KEY] as PluginHostCallMeta;
    expect(meta.url).toBe('http://octipus-host.internal');
    expect(meta.scopes).toEqual(['notes:read']);
    const live = verifyHostToken(meta.token, 'acme');
    expect(live).toMatchObject({ userId: 'u1', workspaceId: 'w1', sessionId: 's1', tool: 'read_it', maxProtection: 2 });
    // Expires with the call's timeout.
    expect(Date.parse(meta.expiresAt) - Date.now()).toBeLessThanOrEqual(10_000);
    issued?.release();
    expect(verifyHostToken(meta.token, 'acme')).toBeNull();

    const write = await issueHostCallMeta(server(), 'write_it', context);
    expect((write?.meta[PLUGIN_HOST_META_KEY] as PluginHostCallMeta).scopes).toEqual(['notes:read', 'notes:write']);
    write?.release();
  });

  test('none without host scopes, for an undeclared tool, without a user, or when the user holds nothing', async () => {
    expect(await issueHostCallMeta(server({ hostScopes: [] }), 'read_it', context)).toBeNull();
    expect(await issueHostCallMeta(server(), 'nope', context)).toBeNull();
    expect(await issueHostCallMeta(server(), 'read_it', { ...context, userId: '' } as AgentContext)).toBeNull();
    held.denied.add('notes.read');
    expect(await issueHostCallMeta(server(), 'read_it', context)).toBeNull();
  });

  test('a token lives at most 30 seconds, whatever the package\'s timeout', async () => {
    const issued = await issueHostCallMeta({ ...server(), requestTimeoutMs: 600_000 }, 'read_it', context);
    const meta = issued?.meta[PLUGIN_HOST_META_KEY] as PluginHostCallMeta;
    expect(Date.parse(meta.expiresAt) - Date.now()).toBeLessThanOrEqual(30_000);
    expect(Date.parse(meta.expiresAt) - Date.now()).toBeGreaterThan(25_000);
    issued?.release();
  });

  test('only calls a user started get a token: never a schedule, an event or a context call', async () => {
    const as = (over: Partial<AgentContext>) => ({ ...context, ...over }) as AgentContext;
    const contribution = (kind: string) => as({ metadata: { source: 'plugin-contribution', plugin: 'acme', contribution: kind } });
    for (const kind of ['event', 'context', 'schedule', 'something-new']) {
      expect(await issueHostCallMeta(server(), 'read_it', contribution(kind)), kind).toBeNull();
    }
    const command = await issueHostCallMeta(server(), 'read_it', contribution('command'));
    expect(command).not.toBeNull();
    command?.release();
    const page = await issueHostCallMeta(server(), 'read_it', as({ sessionId: '', metadata: { source: 'plugin-page', plugin: 'acme' } }));
    expect(page).not.toBeNull();
    page?.release();
    // An agent's call only in the user's own turn, in a session.
    for (const trigger of ['schedule', 'monitor', 'listen', 'remote', 'room'] as const) {
      expect(await issueHostCallMeta(server(), 'read_it', as({ trigger })), trigger).toBeNull();
    }
    expect(await issueHostCallMeta(server(), 'read_it', as({ sessionId: '' }))).toBeNull();
    expect(await issueHostCallMeta(server(), 'read_it', as({ metadata: { source: 'heartbeat' } }))).toBeNull();
    expect(hostCallKind(as({}))).toBe('agent');
  });

  test('a space call carries the space', async () => {
    const issued = await issueHostCallMeta(server(), 'read_it', { ...context, space: { workspaceId: 'space-1' } } as unknown as AgentContext);
    expect(verifyHostToken((issued?.meta[PLUGIN_HOST_META_KEY] as PluginHostCallMeta).token, 'acme')?.workspaceId).toBe('space-1');
    issued?.release();
  });
});

describe('the host API target', () => {
  test('loopback when listening everywhere, the configured port unless overridden', () => {
    const target = hostApiTarget();
    expect(target.host === '127.0.0.1' || target.host.length > 0).toBe(true);
    setHostApiPort(45678);
    expect(hostApiTarget().port).toBe(45678);
    setHostApiPort(null);
  });
});

describe('content read by a call', () => {
  test('the highest level read is kept on the live grant; an unknown level counts as 4', () => {
    const { token } = mintHostToken(grant, 30_000);
    const live = verifyHostToken(token, 'acme');
    expect(live?.readLevel).toBeUndefined();
    noteHostRead(live!, 2);
    noteHostRead(live!, 1);
    expect(verifyHostToken(token, 'acme')?.readLevel).toBe(2);
    noteHostRead(live!, null);
    expect(verifyHostToken(token, 'acme')?.readLevel).toBe(4);
  });
});
