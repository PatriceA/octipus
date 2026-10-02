/**
 * Regression: a TUI session has channelType 'tui', which is not a messaging
 * channel. The forwarder used to call umi.send('tui', …), which throws for an
 * unregistered type, and the catch denied the request within milliseconds —
 * so the permission prompt the user was looking at in the TUI was already
 * resolved before they could answer it.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getUMI } from '@/channels/interface';

// The enrolment the group sessions below belong to; null = channel removed.
const enrolment = vi.hoisted(() => ({ group: { id: 'g1' } as { id: string } | null, active: true }));
vi.mock('./group-channels', () => ({
  findGroupChannel: async () => enrolment.group,
  isGroupChannelActive: async () => enrolment.active,
}));
import { sessionRepository } from '@/db/repositories/session-repository';
import { getPermissionManager } from '@/security/permissions';
import { _resetPendingChannelPermissionsForTests, forgetResolvedChannelPermission, forwardPermissionRequestToChannel, tryResolvePermissionFromChannel } from './index';

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
  beforeEach(() => {
    _resetPendingChannelPermissionsForTests();
    enrolment.group = { id: 'g1' };
    enrolment.active = true;
  });

  let n = 0;
  const reply = (over: Partial<import('@/core/types').UnifiedMessage>) => ({
    id: 'm', channelType: 'slack' as const, channelId: 'C1', userId: 'u-anna', content: 'yes',
    threadId: '90.0', timestamp: new Date(), metadata: { groupChannelId: 'g1' }, ...over,
  });

  /** Ask in a group thread (or, with `thread: null`, in a 1:1 chat); returns the request id. */
  async function ask(opts: { thread?: string | null; channelId?: string; privateOk?: boolean; args?: Record<string, unknown> } = {}) {
    const requestId = `r-${++n}`;
    const thread = opts.thread === undefined ? '90.0' : opts.thread;
    vi.spyOn(sessionRepository, 'findById').mockResolvedValue(
      (thread === null
        ? { id: 's-dm', channelType: 'slack', channelId: opts.channelId ?? 'D-ANNA' }
        : { id: 's-group', channelType: 'slack', channelId: opts.channelId ?? 'C1', threadId: thread, groupChannelId: 'g1' }) as never,
    );
    const { userRepository } = await import('@/db/repositories/user-repository');
    vi.spyOn(userRepository, 'findById').mockResolvedValue({ id: 'u-anna', username: 'anna' } as never);
    const send = vi.spyOn(getUMI(), 'send').mockResolvedValue('ts');
    const sendPrivate = vi.spyOn(getUMI(), 'sendPrivate').mockResolvedValue(opts.privateOk ?? true);
    await forwardPermissionRequestToChannel({
      ...request, requestId, userId: 'u-anna', sessionId: 's',
      args: opts.args ?? { target: 'accountant@x.example', message: 'My SSN is 123-45-6789' },
    });
    return { requestId, send, sendPrivate };
  }

  test('details go only to the requester; the thread gets a prompt without them', async () => {
    const { send, sendPrivate } = await ask();
    expect(sendPrivate).toHaveBeenCalledWith('slack', 'C1', 'u-anna', expect.objectContaining({
      threadId: '90.0', content: expect.stringContaining('My SSN is 123-45-6789'),
    }));
    const publicText = (send.mock.calls[0]![2] as { content: string }).content;
    expect(send.mock.calls[0]![2]).toMatchObject({ threadId: '90.0' });
    expect(publicText).toContain('anna: Octipus needs your permission');
    expect(publicText).toContain('only you can see them');
    expect(publicText).not.toContain('SSN');
    expect(publicText).not.toContain('accountant@');
  });

  test('when the details cannot be shown privately they are still never posted publicly', async () => {
    const { send } = await ask({ privateOk: false });
    const publicText = (send.mock.calls[0]![2] as { content: string }).content;
    expect(publicText).toContain('web app');
    expect(publicText).not.toContain('SSN');
  });

  test("another member's yes, or the requester's yes elsewhere, does not resolve it", async () => {
    const { requestId } = await ask();
    const approve = vi.spyOn(getPermissionManager(), 'approve').mockResolvedValue(true);
    expect(await tryResolvePermissionFromChannel(reply({ userId: 'u-bob' }))).toBe(false);
    expect(await tryResolvePermissionFromChannel(reply({ threadId: '80.0' }))).toBe(false);
    expect(await tryResolvePermissionFromChannel(reply({ channelId: 'D-ANNA', threadId: undefined, metadata: {} }))).toBe(false);
    expect(approve).not.toHaveBeenCalled();

    expect(await tryResolvePermissionFromChannel(reply({}))).toBe(true);
    expect(approve).toHaveBeenCalledWith(requestId, 'u-anna');
  });

  test('prompts waiting in two threads and a DM are each answerable where they were asked', async () => {
    const a = await ask({ thread: '90.0' });
    const b = await ask({ thread: '95.0' });
    const dm = await ask({ thread: null });
    const approve = vi.spyOn(getPermissionManager(), 'approve').mockResolvedValue(true);
    expect(await tryResolvePermissionFromChannel(reply({ threadId: '90.0' }))).toBe(true);
    expect(await tryResolvePermissionFromChannel(reply({ threadId: '95.0' }))).toBe(true);
    expect(await tryResolvePermissionFromChannel(reply({ channelId: 'D-ANNA', threadId: undefined, metadata: {} }))).toBe(true);
    expect(approve.mock.calls.map(c => c[0])).toEqual([a.requestId, b.requestId, dm.requestId]);
  });

  test('a reply answers the newest prompt and the confirmation names its tool', async () => {
    const older = await ask();
    const newer = await ask();
    const approve = vi.spyOn(getPermissionManager(), 'approve').mockResolvedValue(true);
    const send = vi.spyOn(getUMI(), 'send').mockResolvedValue('ts');
    expect(await tryResolvePermissionFromChannel(reply({}))).toBe(true);
    expect(approve.mock.calls.map(c => c[0])).toEqual([newer.requestId]);
    expect(send).toHaveBeenCalledWith('slack', 'C1', expect.objectContaining({
      threadId: '90.0', content: 'Permission granted for "shell__run". Continuing... (1 more permission request waiting.)',
    }));
    expect(await tryResolvePermissionFromChannel(reply({}))).toBe(true);
    expect(approve.mock.calls.map(c => c[0])).toEqual([newer.requestId, older.requestId]);
  });

  test('a prompt resolved elsewhere (web UI, expiry) is forgotten; the next yes is an ordinary message', async () => {
    const { requestId } = await ask();
    forgetResolvedChannelPermission({ userId: 'u-anna', requestId });
    const approve = vi.spyOn(getPermissionManager(), 'approve').mockResolvedValue(true);
    expect(await tryResolvePermissionFromChannel(reply({}))).toBe(false);
    expect(approve).not.toHaveBeenCalled();
  });

  test('if the newest prompt was resolved elsewhere a moment ago, the reply never falls through to an older one', async () => {
    const older = await ask();
    const newer = await ask();
    const approve = vi.spyOn(getPermissionManager(), 'approve').mockImplementation(async (id: string) => id !== newer.requestId);
    const send = vi.spyOn(getUMI(), 'send').mockResolvedValue('ts');
    expect(await tryResolvePermissionFromChannel(reply({}))).toBe(true);
    expect(approve.mock.calls.map(c => c[0])).toEqual([newer.requestId]);
    expect(send).toHaveBeenCalledWith('slack', 'C1', expect.objectContaining({
      content: expect.stringContaining('already answered elsewhere or has expired; nothing was changed. (1 more'),
    }));
    // the older prompt is still waiting for its own answer
    expect(await tryResolvePermissionFromChannel(reply({}))).toBe(true);
    expect(approve.mock.calls.map(c => c[0])).toEqual([newer.requestId, older.requestId]);
  });

  test('in a group thread only a bare yes/no answers; talk to colleagues does not', async () => {
    await ask();
    const approve = vi.spyOn(getPermissionManager(), 'approve').mockResolvedValue(true);
    for (const content of ["ok I'll check with Dana first", 'yes but later', 'sure', 'go'])
      expect(await tryResolvePermissionFromChannel(reply({ content }))).toBe(false);
    expect(approve).not.toHaveBeenCalled();
    expect(await tryResolvePermissionFromChannel(reply({ content: 'Yes!' }))).toBe(true);
  });

  test('if approving fails, the prompt stays answerable', async () => {
    const { requestId } = await ask();
    const approve = vi.spyOn(getPermissionManager(), 'approve').mockRejectedValueOnce(new Error('db down'));
    await expect(tryResolvePermissionFromChannel(reply({}))).rejects.toThrow('db down');
    approve.mockResolvedValue(true);
    expect(await tryResolvePermissionFromChannel(reply({}))).toBe(true);
    expect(approve).toHaveBeenLastCalledWith(requestId, 'u-anna');
  });

  test('nothing is posted for a thread whose channel is paused (owner deactivated)', async () => {
    enrolment.active = false;
    const { send, sendPrivate } = await ask();
    expect(send).not.toHaveBeenCalled();
    expect(sendPrivate).not.toHaveBeenCalled();
  });

  test('nothing is posted for a thread whose channel is no longer enrolled', async () => {
    enrolment.group = null;
    const { send, sendPrivate } = await ask();
    expect(send).not.toHaveBeenCalled();
    expect(sendPrivate).not.toHaveBeenCalled();
    expect(await tryResolvePermissionFromChannel(reply({}))).toBe(false);
  });

  test('a request resolved before its prompt was recorded is not queued', async () => {
    forgetResolvedChannelPermission({ userId: 'u-anna', requestId: `r-${n + 1}` });
    const { send } = await ask();
    expect(send).not.toHaveBeenCalled();
    expect(await tryResolvePermissionFromChannel(reply({}))).toBe(false);
  });

  test('a reply cannot answer a prompt that has not been shown yet', async () => {
    vi.spyOn(sessionRepository, 'findById').mockResolvedValue(
      { id: 's-group', channelType: 'slack', channelId: 'C1', threadId: '90.0', groupChannelId: 'g1' } as never,
    );
    const { userRepository } = await import('@/db/repositories/user-repository');
    vi.spyOn(userRepository, 'findById').mockResolvedValue({ id: 'u-anna', username: 'anna' } as never);
    vi.spyOn(getUMI(), 'sendPrivate').mockResolvedValue(true);
    let release!: () => void;
    // The thread prompt is still in flight; later sends (the confirmation) go through.
    vi.spyOn(getUMI(), 'send')
      .mockImplementationOnce(() => new Promise<string>((r) => { release = () => r('ts'); }))
      .mockResolvedValue('ts');
    const approve = vi.spyOn(getPermissionManager(), 'approve').mockResolvedValue(true);
    const forwarding = forwardPermissionRequestToChannel({ ...request, requestId: 'r-unseen', userId: 'u-anna', sessionId: 's' });
    await new Promise((r) => setTimeout(r, 10)); // queued, prompt still being posted
    expect(await tryResolvePermissionFromChannel(reply({}))).toBe(false);
    release();
    await forwarding;
    expect(await tryResolvePermissionFromChannel(reply({}))).toBe(true);
    expect(approve).toHaveBeenCalledWith('r-unseen', 'u-anna');
  });

  test('a removed or paused channel: nothing posted, and the request is denied so the turn does not hang', async () => {
    const deny = vi.spyOn(getPermissionManager(), 'deny').mockResolvedValue(true);
    enrolment.group = null;
    const removed = await ask();
    enrolment.group = { id: 'g1' };
    enrolment.active = false;
    const paused = await ask();
    expect(removed.send).not.toHaveBeenCalled();
    expect(paused.send).not.toHaveBeenCalled();
    expect(deny).toHaveBeenCalledWith(removed.requestId, 'u-anna', expect.stringContaining('removed or is paused'));
    expect(deny).toHaveBeenCalledWith(paused.requestId, 'u-anna', expect.stringContaining('removed or is paused'));
  });
});
