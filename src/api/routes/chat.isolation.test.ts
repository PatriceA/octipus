/**
 * Cross-tenant isolation test for the chat-route's two new gaps.
 *
 * The route delegates approval logic to the orchestrator's ApprovalManager.
 * Phase 1a tightened that manager so:
 *   - getPendingApprovals(forUserId) filters by owner
 *   - peek(requestId) lets callers verify ownership before resolving
 *
 * Both checks are pure (no DB, no network) so we exercise them directly
 * here rather than rebuilding a stub orchestrator service. The
 * route-level chat session-ownership branch is already covered by
 * sessions.isolation.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { ApprovalManager } from '@/core/orchestrator/approval-manager';

const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';

function ctx(userId: string) {
  return {
    sessionId: `sess-${userId}`,
    userId,
    id: `agent-${userId}`,
    role: 'general',
    model: 'm',
    topic: 't',
    metadata: {},
    createdAt: new Date(),
  } as any;
}

describe('ApprovalManager.getPendingApprovals(forUserId)', () => {
  test('returns only the principal’s pending approvals when filter is set', () => {
    const m = new ApprovalManager();
    // requestApproval emits a notification side-effect; pass a no-op
    // emit fn and ignore the returned promise (request stays pending
    // until resolveApproval is called).
    m.requestApproval('a', 'a?', ctx(aliceId), () => {}).catch(() => {});
    m.requestApproval('b', 'b?', ctx(bobId), () => {}).catch(() => {});
    m.requestApproval('a2', 'a?', ctx(aliceId), () => {}).catch(() => {});

    const aliceOnly = m.getPendingApprovals(aliceId);
    expect(aliceOnly).toHaveLength(2);
    expect(aliceOnly.every((r) => r.userId === aliceId)).toBe(true);

    const bobOnly = m.getPendingApprovals(bobId);
    expect(bobOnly).toHaveLength(1);
    expect(bobOnly[0].userId).toBe(bobId);
  });

  test('returns global list when no filter (admin path)', () => {
    const m = new ApprovalManager();
    m.requestApproval('a', 'a?', ctx(aliceId), () => {}).catch(() => {});
    m.requestApproval('b', 'b?', ctx(bobId), () => {}).catch(() => {});

    const all = m.getPendingApprovals();
    expect(all).toHaveLength(2);
  });
});

describe('ApprovalManager.peek', () => {
  test('returns the pending request with userId so callers can verify ownership', () => {
    const m = new ApprovalManager();
    m.requestApproval('a', 'a?', ctx(aliceId), () => {}).catch(() => {});
    const id = m.getPendingApprovals()[0].id;

    const peeked = m.peek(id);
    expect(peeked).not.toBeNull();
    expect(peeked!.userId).toBe(aliceId);
    expect(peeked!.sessionId).toBe(`sess-${aliceId}`);
  });

  test('returns null for unknown request ids', () => {
    const m = new ApprovalManager();
    expect(m.peek('does-not-exist')).toBeNull();
  });
});
