/**
 * Regression: a TUI session has channelType 'tui', which is not a messaging
 * channel. The forwarder used to call umi.send('tui', …), which throws for an
 * unregistered type, and the catch denied the request within milliseconds —
 * so the permission prompt the user was looking at in the TUI was already
 * resolved before they could answer it.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { getUMI } from '@/channels/interface';
import { sessionRepository } from '@/db/repositories/session-repository';
import { getPermissionManager } from '@/security/permissions';
import { forwardPermissionRequestToChannel, tryResolvePermissionFromChannel } from './index';

const request = {
  requestId: 'r1', userId: 'u1', agentId: 'a1', toolId: 'shell',
  action: 'run', toolName: 'shell__run', args: { command: 'ls' }, sessionId: 's1',
};

function stubSession(channelType: string) {
  vi.spyOn(sessionRepository, 'findById').mockResolvedValue(
    { id: 's1', channelType, channelId: 'c1' } as never,
  );
}

describe('forwardPermissionRequestToChannel', () => {
  afterEach(() => vi.restoreAllMocks());

  test('non-messaging channelType is ignored, not denied', async () => {
    stubSession('tui');
    const deny = vi.spyOn(getPermissionManager(), 'deny').mockResolvedValue(true);
    await forwardPermissionRequestToChannel(request);
    expect(deny).not.toHaveBeenCalled();
  });

  test('messaging channel that fails to send IS denied', async () => {
    stubSession('telegram');
    const deny = vi.spyOn(getPermissionManager(), 'deny').mockResolvedValue(true);
    const umi = getUMI();
    vi.spyOn(umi, 'send').mockRejectedValue(new Error('not connected'));
    await forwardPermissionRequestToChannel(request);
    expect(deny).toHaveBeenCalledWith('r1', 'u1', expect.stringContaining('telegram'));
  });
});

describe('permission prompts in a group channel thread', () => {
  afterEach(() => vi.restoreAllMocks());

  const groupRequest = { ...request, requestId: 'r-group', userId: 'u-anna', sessionId: 's-group' };
  const reply = (over: Partial<import('@/core/types').UnifiedMessage>) => ({
    id: 'm', channelType: 'slack' as const, channelId: 'C1', userId: 'u-anna', content: 'yes',
    threadId: '90.0', timestamp: new Date(), ...over,
  });

  async function ask() {
    vi.spyOn(sessionRepository, 'findById').mockResolvedValue(
      { id: 's-group', channelType: 'slack', channelId: 'C1', threadId: '90.0', groupChannelId: 'g1' } as never,
    );
    const { userRepository } = await import('@/db/repositories/user-repository');
    vi.spyOn(userRepository, 'findById').mockResolvedValue({ id: 'u-anna', username: 'anna' } as never);
    const send = vi.spyOn(getUMI(), 'send').mockResolvedValue('ts');
    await forwardPermissionRequestToChannel(groupRequest);
    return send;
  }

  test('the prompt goes into the thread and names who must answer', async () => {
    const send = await ask();
    expect(send).toHaveBeenCalledWith('slack', 'C1', expect.objectContaining({
      threadId: '90.0',
      content: expect.stringContaining('anna: only you can answer this'),
    }));
  });

  test("another member's yes, or the requester's yes elsewhere, does not resolve it", async () => {
    await ask();
    const approve = vi.spyOn(getPermissionManager(), 'approve').mockResolvedValue(true);
    expect(await tryResolvePermissionFromChannel(reply({ userId: 'u-bob' }))).toBe(false);
    expect(await tryResolvePermissionFromChannel(reply({ threadId: '80.0' }))).toBe(false);
    expect(await tryResolvePermissionFromChannel(reply({ channelId: 'D-ANNA', threadId: undefined }))).toBe(false);
    expect(approve).not.toHaveBeenCalled();

    expect(await tryResolvePermissionFromChannel(reply({}))).toBe(true);
    expect(approve).toHaveBeenCalledWith('r-group', 'u-anna');
  });
});
