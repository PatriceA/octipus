/**
 * The one way an agent start gets its context hooks (docs/CONTEXT-HOOKS.md,
 * docs/plans/recall-hardening.md §1). Every path that starts an agent on a
 * user's message or brief calls `contextForAgentStart`; the spawn-site test
 * (coverage.test.ts) fails when a new start path neither calls it nor is
 * listed as exempt with its reason.
 *
 * The audience rule lives here, once: no hook runs where other people read
 * the reply (a group thread, a room, a space on another install) nor where
 * the session's text may not be copied anywhere (`contentStorageOff`).
 */
import { type AudienceSession, type SessionAudience, sessionAudience } from '@/core/agent/audience';
import type { AgentContext } from '@/core/types';
import { isRealUserId } from '@/security/principal';
import { coreLogger } from '@/utils/logger';
import { searchesWithPreviousMessage } from './recall';
import { type ContextHooksOutcome, runContextHooks } from './run';
import type { ContextHookEvent } from './types';

/** What an agent start gets when no hook may run: nothing injected, no record to finish. */
const none = (): ContextHooksOutcome => ({ text: '', blocks: [], labelledBlocks: [], repeatable: [], turn: null });

interface AgentStartBase {
  event: ContextHookEvent;
  /** The requester. Anything but a real user (`'system'`, empty) gets no hooks. */
  userId: string | null | undefined;
  workspaceId: string | null;
  /** The session the agent runs in: its protection level follows what is shown. */
  sessionId: string;
  space?: AgentContext['space'];
  /** The message (a root turn, a side question) or the brief (a worker, a child). */
  query: string;
  /** The role the agent runs as, for the measurement record. */
  role?: string;
  channel?: string;
  /**
   * A root turn or a side question the user typed: a short message is
   * searched together with the previous message the user typed in this
   * session (`buildRecallQuery`). Read only when a recall hook runs and the
   * message is short. Workers and children never set it: their brief is
   * self-contained.
   */
  followUp?: boolean;
  /**
   * The start can still be refused after its hooks run (the spawn's
   * concurrency, quota and space checks): the shown passages count as read
   * only once `bindTurnToAgent` binds the record to the started agent.
   */
  accessOnStart?: boolean;
}

/**
 * Who reads the replies: the audience when the caller already resolved it,
 * else the session it is resolved from (`sessionAudience`; `null` is a
 * session that does not exist yet, which is personal).
 */
export type AgentStartInput = AgentStartBase & ({ audience: SessionAudience } | { session: AudienceSession | null });

/** Whether hooks may run for this audience: not where others read the reply, not where nothing may be copied. */
export function audienceAllowsContextHooks(audience: SessionAudience): boolean {
  return !audience.shared && !audience.contentStorageOff;
}

/**
 * The context hooks' outcome for one agent start: the blocks to inject and
 * the turn record to finish (`finishContextTurn`; `bindTurnToAgent` first
 * when the record should count only one agent's tool calls). Empty
 * when the audience forbids hooks or there is no user. Never throws.
 */
export async function contextForAgentStart(input: AgentStartInput): Promise<ContextHooksOutcome> {
  try {
    if (!isRealUserId(input.userId)) return none();
    const audience = 'audience' in input ? input.audience : await sessionAudience(input.session);
    if (!audienceAllowsContextHooks(audience)) return none();
    const userId = input.userId;
    return await runContextHooks({
      event: input.event,
      userId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      space: input.space,
      query: input.query,
      ...(input.role ? { role: input.role } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.accessOnStart ? { accessOnStart: true } : {}),
      ...(input.followUp && searchesWithPreviousMessage(input.query)
        ? { previousMessage: () => previousTypedMessage(userId, input.sessionId, input.query) }
        : {}),
    });
  } catch (err) {
    // The audience could not be read (a session whose workspace kind is
    // unknown): no hooks, never a guess that the session is personal.
    coreLogger.warn({ err, userId: input.userId, sessionId: input.sessionId, event: input.event }, 'context hooks: could not start — agent starts without them');
    return none();
  }
}

/**
 * The last message the user typed in this session before `current`: their
 * own words only (no schedule, monitor or Companion row, no text the service
 * composed such as a plan brief, nothing internal) and only in the session's
 * current conversation generation, so nothing from before a clear
 * (`loadRecentOwnerMessages`). Undefined when there is none or it cannot be
 * read: the message is then searched alone.
 */
export async function previousTypedMessage(userId: string, sessionId: string, current: string): Promise<string | undefined> {
  try {
    const { loadRecentOwnerMessages } = await import('@/core/memory/owner-messages');
    // Newest first. This turn's own row is normally not stored yet; when it
    // is (a confirmed voice request stores its "yes" first), it is skipped.
    const rows = await loadRecentOwnerMessages(userId, sessionId, 2);
    const now = current.trim();
    return rows.map((r) => r.text.trim()).find((text) => text && text !== now);
  } catch (err) {
    coreLogger.warn({ err, sessionId }, 'context hooks: the previous message could not be read — the message is searched alone');
    return undefined;
  }
}
