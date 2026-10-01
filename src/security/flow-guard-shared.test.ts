/**
 * Group-channel sessions (docs/plans/group-chat-bot.md §4): the reply is read
 * by every member, so the session starts `suspicious` and reading the
 * requester's private data needs approval even where policy says ALLOW.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stored = vi.hoisted(() => ({ findById: vi.fn() }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: stored }));
import { applyFlowGuard, clearFlowLabel, ensureSharedAudienceKnown, getFlowLabel, isSharedAudience, markNotSharedAudience, markSharedAudience, resetFlowLabels } from './flow-guard';
import type { PermissionCheckResult } from './permissions';

const allow = { allowed: true, level: 'ALLOW', requiresApproval: false } as PermissionCheckResult;
const GROUP = 'group-session';
const PRIVATE = 'one-to-one-session';
const guard = (sessionId: string, toolId: string, action: string) => applyFlowGuard('ask', sessionId, { toolId, action }, allow);

describe('shared-audience sessions', () => {
  beforeEach(() => {
    resetFlowLabels();
    markSharedAudience(GROUP);
  });

  it('start suspicious, with the transcript as the source', () => {
    expect(isSharedAudience(GROUP)).toBe(true);
    expect(getFlowLabel(GROUP)).toMatchObject({ suspicious: true, private: false, secret: false });
    expect(getFlowLabel(GROUP).sources.suspicious).toBe('group-channel:transcript');
  });

  it('ask before reading private data; the same read is fine in a 1:1 session', () => {
    const res = guard(GROUP, 'google-workspace', 'email_read');
    expect(res).toMatchObject({ level: 'ASK', requiresApproval: true, source: 'flow-guard' });
    expect(res.reason).toMatch(/shared group channel.*google-workspace:email_read/);
    expect(guard(PRIVATE, 'google-workspace', 'email_read')).toBe(allow);
  });

  it('leave non-private work alone', () => {
    expect(guard(GROUP, 'websearch', 'search')).toBe(allow);
    expect(guard(GROUP, 'shell', 'execute')).toBe(allow);
  });

  it('never loosen a DENY, and stay off when the guard is off', () => {
    const deny = { allowed: false, level: 'DENY', requiresApproval: false } as PermissionCheckResult;
    expect(applyFlowGuard('ask', GROUP, { toolId: 'data', action: 'query' }, deny)).toBe(deny);
    expect(applyFlowGuard('off', GROUP, { toolId: 'data', action: 'query' }, allow)).toBe(allow);
  });

  it('forget the mark with the label', () => {
    clearFlowLabel(GROUP);
    expect(isSharedAudience(GROUP)).toBe(false);
    expect(guard(GROUP, 'data', 'query')).toBe(allow);
  });
});

describe('ensureSharedAudienceKnown', () => {
  beforeEach(() => {
    resetFlowLabels();
    stored.findById.mockReset();
  });

  it('marks a group-thread session from the stored row, for runs that did not start with a turn', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    stored.findById.mockResolvedValue({ id, groupChannelId: 'g1' });
    await ensureSharedAudienceKnown(id);
    expect(isSharedAudience(id)).toBe(true);
    expect(guard(id, 'data', 'query')).toMatchObject({ level: 'ASK' });
  });

  it('looks each session up once; a 1:1 session stays unmarked', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    stored.findById.mockResolvedValue({ id, groupChannelId: null });
    await ensureSharedAudienceKnown(id);
    await ensureSharedAudienceKnown(id);
    expect(stored.findById).toHaveBeenCalledTimes(1);
    expect(isSharedAudience(id)).toBe(false);
  });

  it('fails closed: while the lookup errors the session is treated as shared, then settles', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    stored.findById.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce({ id, groupChannelId: null });
    await ensureSharedAudienceKnown(id);
    expect(isSharedAudience(id)).toBe(true);
    const res = guard(id, 'data', 'query');
    expect(res).toMatchObject({ level: 'ASK' });
    expect(res.reason).toMatch(/could not be confirmed/);
    // and it carries the untrusted-text taint a group session starts with
    expect(getFlowLabel(id).suspicious).toBe(true);
    await ensureSharedAudienceKnown(id);
    expect(isSharedAudience(id)).toBe(false);
  });

  it('a session the service already read as 1:1 is not looked up again', async () => {
    const id = '55555555-5555-4555-8555-555555555555';
    markNotSharedAudience(id);
    await ensureSharedAudienceKnown(id);
    expect(stored.findById).not.toHaveBeenCalled();
    expect(isSharedAudience(id)).toBe(false);
  });

  it('synthetic session ids are not looked up at all', async () => {
    await ensureSharedAudienceKnown('artifact-refresh:abc');
    await ensureSharedAudienceKnown('artifact-refresh:abc');
    expect(stored.findById).not.toHaveBeenCalled();
    expect(isSharedAudience('artifact-refresh:abc')).toBe(false);
  });

  it('clearing a label forgets the lookup too, so the session is checked again', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    stored.findById.mockResolvedValue({ id, groupChannelId: 'g1' });
    await ensureSharedAudienceKnown(id);
    clearFlowLabel(id);
    expect(isSharedAudience(id)).toBe(false);
    await ensureSharedAudienceKnown(id);
    expect(isSharedAudience(id)).toBe(true);
    expect(stored.findById).toHaveBeenCalledTimes(2);
  });
});
