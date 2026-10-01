/**
 * Group-channel sessions (docs/plans/group-chat-bot.md §4): the reply is read
 * by every member, so the session starts `suspicious` and reading the
 * requester's private data needs approval even where policy says ALLOW.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyFlowGuard, clearFlowLabel, getFlowLabel, isSharedAudience, markSharedAudience, resetFlowLabels } from './flow-guard';
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
