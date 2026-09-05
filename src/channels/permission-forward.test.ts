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
import { forwardPermissionRequestToChannel } from './index';

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
