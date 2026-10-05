import { getConfig } from '@/config';
import { type SessionAudience, sessionAudience } from './audience';
import { capNativeSnapshot, readSessionHistory, toContextMessage, withSessionConversation } from '@/core/session-history';
import { getModelRegistry } from '@/models/model-registry';
import { getGatewayHub } from '@/core/gateway/hub';
import { compactionEntryRepository } from '@/db/repositories/compaction-entry-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { CHILD_CLI_SESSION_KEY_PREFIXES } from '@/core/cli-session-store';
import type { CompactionState, } from '@/db/schema/sessions';
import { calculateTotalTokens, createLLMSummary } from '@/utils/context-compaction';
import { coreLogger } from '@/utils/logger';
import { compactCliConversation, rootCliConversation } from '@/core/cli-compaction';

const COMPACTION_MESSAGE_THRESHOLD = 20;
const COMPACTION_TOKEN_THRESHOLD = 8000;

/**
 * Inputs required by {@link decideCompaction}. Extracted so the decision can
 * be exercised directly in unit tests without a DB or gateway.
 */
export interface CompactionDecisionInput {
  currentTokens: number;
  state: CompactionState | undefined;
  config: {
    minSavingsRatio: number;
    growthMultiplier: number;
    hardCeiling: number;
  };
}

export type CompactionDecision =
  | { allow: true; reason: 'first-pass' | 'growth-threshold' | 'hard-ceiling' | 'no-prior-stall' }
  | { allow: false; reason: 'stalled-awaiting-growth'; nextEligibleTokens: number };

/**
 * Pure decision function — should the next compaction pass run?
 *
 * Matrix:
 *   1. No prior compaction           → allow (first-pass)
 *   2. Prior pass not stalled        → allow (no-prior-stall)
 *   3. Stalled, currentTokens ≥ hardCeiling           → allow (hard-ceiling, safety valve)
 *   4. Stalled, currentTokens ≥ lastCompactTokens × growthMultiplier → allow (growth-threshold)
 *   5. Stalled, otherwise            → skip (stalled-awaiting-growth)
 */
export function decideCompaction(input: CompactionDecisionInput): CompactionDecision {
  const { currentTokens, state, config } = input;

  if (!state || state.lastCompactedAt === undefined || state.lastCompactTokens === undefined) {
    return { allow: true, reason: 'first-pass' };
  }

  if (!state.compactionIneffective) {
    return { allow: true, reason: 'no-prior-stall' };
  }

  // Stalled — only two ways out.
  if (currentTokens >= config.hardCeiling) {
    return { allow: true, reason: 'hard-ceiling' };
  }

  const nextEligibleTokens = Math.ceil(state.lastCompactTokens * config.growthMultiplier);
  if (currentTokens >= nextEligibleTokens) {
    return { allow: true, reason: 'growth-threshold' };
  }

  return { allow: false, reason: 'stalled-awaiting-growth', nextEligibleTokens };
}

export interface MaybeCompactSessionOptions {
  /**
   * Free-form `/compact <instructions>` payload. When provided, bypasses the
   * threshold and stall checks (the user explicitly asked to compact).
   */
  userInstructions?: string;
  /** Bypass the anti-thrashing stall guard. Used by manual `/compact`. */
  force?: boolean;
  /**
   * A room (§6.4): the requester of the turn that triggered the pass, or
   * the caller of `/compact`. The summary call is attributed to them, funded
   * by the install. Required for a room.
   */
  requesterId?: string;
}

/**
 * Check if a session needs compaction and trigger it if so.
 * Returns true only when a new checkpoint was committed.
 *
 * Respects the anti-thrashing guard: if the prior pass was ineffective we
 * skip further passes until the session has grown by `growthMultiplier` ×
 * the previous pre-compact size, or the token count hits the hard ceiling.
 */
export async function maybeCompactSession(sessionId: string, options: MaybeCompactSessionOptions = {}): Promise<boolean> {
  return withSessionConversation(sessionId, async () => {
    const session = await sessionRepository.findById(sessionId);
    if (session?.kind === 'room') return compactRoom(sessionId, options);
    // Vendor histories are richer than the Octipus transcript. Automatic
    // maintenance must never rotate them onto a lossy Octipus checkpoint.
    if (session && rootCliConversation(session)) return false;
    const history = await readSessionHistory(sessionId);
    if (!history.session || history.rows.length < 2) return false;
    const savedNative = history.session.context?.nativeConversation;
    const acknowledgedIndex = savedNative ? history.rows.findIndex(row => row.id === savedNative.acknowledged.id) : -1;
    const activeMessages = savedNative?.generation === history.generation && savedNative.checkpointId === history.checkpoint?.entryId
      ? [...savedNative.messages.map(m => ({ ...m, timestamp: new Date(m.timestamp) })), ...history.rows.slice(acknowledgedIndex + 1).map(toContextMessage)]
      : history.messages;
    const tokensBefore = calculateTotalTokens(activeMessages);
    const manual = Boolean(options.force || options.userInstructions);
    if (!manual && history.rows.length < COMPACTION_MESSAGE_THRESHOLD && tokensBefore < COMPACTION_TOKEN_THRESHOLD) return false;
    const cfg = getConfig().compaction;
    const state = history.session.context?.compactionState;
    const decision = decideCompaction({ currentTokens: tokensBefore, state, config: cfg });
    if (!manual && !decision.allow) return false;
    // Summarize a contiguous prefix. Retain its exact suffix, never an unrelated
    // original-user anchor that makes coverage ambiguous.
    // Retain complete user/answer pairs so native tool sequences are not split.
    let boundary = Math.max(1, history.rows.length - 6);
    while (boundary < history.rows.length && history.rows[boundary].role !== 'user') boundary++;
    if (boundary === history.rows.length) return false;
    const keep = history.rows.length - boundary;
    const prefix = history.rows.slice(0, boundary);
    if (!prefix.length) return false;
    const model = await getModelRegistry().getDefaultModel();
    if (!model) throw new Error('No model configured for session compaction');
    let summaryInput = prefix.map(toContextMessage);
    let nativeTail: NonNullable<typeof savedNative>['messages'] | undefined;
    const native = history.session.context?.nativeConversation;
    if (native?.generation === history.generation && native.checkpointId === history.checkpoint?.entryId) {
      const nativeBoundary = native.messages.findIndex(m => m.sourceMessageId === history.rows[boundary].id);
      if (nativeBoundary > 0) {
        nativeTail = native.messages.slice(nativeBoundary);
        summaryInput = native.messages.slice(0, nativeBoundary)
          .filter(m => !m.content.startsWith('[Conversation checkpoint]'))
          .map(m => ({ ...m, timestamp: new Date(m.timestamp) }));
      } else {
        const acknowledgedIndex = prefix.findIndex(row => row.id === native.acknowledged.id);
        if (acknowledgedIndex >= 0) summaryInput = [
          ...native.messages.filter(m => !m.content.startsWith('[Conversation checkpoint]')).map(m => ({ ...m, timestamp: new Date(m.timestamp) })),
          ...prefix.slice(acknowledgedIndex + 1).map(toContextMessage),
        ];
      }
    }
    const result = await createLLMSummary(summaryInput, model.modelId, {
      previousSummary: history.checkpoint?.summary,
      previousFileOps: history.checkpoint?.fileOps,
      userInstructions: options.userInstructions,
      userId: history.session.userId,
      requireSuccess: true,
    });
    if (!result.summaryText.trim()) return false;
    const summary = result.message.content;
    const tokensAfter = calculateTotalTokens([
      { role: 'user', content: summary, timestamp: new Date() },
      ...(nativeTail ? nativeTail.map(m => ({ ...m, timestamp: new Date(m.timestamp) })) : history.rows.slice(-keep).map(toContextMessage)),
    ]);
    const savingsRatio = tokensBefore > 0 ? (tokensBefore - tokensAfter) / tokensBefore : 0;
    if (savingsRatio < cfg.minSavingsRatio && !manual) {
      const stalled = await sessionRepository.patchContextIfGeneration(sessionId, history.generation, {
        compactionState: { lastCompactedAt: new Date().toISOString(), lastCompactTokens: tokensBefore,
          lastSavingsRatio: savingsRatio, compactionIneffective: true,
          ineffectivePasses: (state?.ineffectivePasses ?? 0) + 1 },
      });
      if (stalled) {
        try {
          getGatewayHub().publishEvent({ type: 'session.compaction_stalled', source: 'session-compaction',
            sessionId, userId: history.session.userId, payload: { sessionId, ratio: savingsRatio,
              ineffectivePasses: (state?.ineffectivePasses ?? 0) + 1,
              nextEligibleTokens: Math.ceil(tokensBefore * cfg.growthMultiplier) } });
        } catch (err) { coreLogger.debug({ err, sessionId }, 'Could not publish compaction stall event'); }
      }
      return false;
    }
    const last = prefix[prefix.length - 1];
    // Read before anything is written: a failed read must fail the pass,
    // not reject after the checkpoint is already published.
    const audience = await sessionAudience(history.session);
    // Persist the audit entry before publishing its checkpoint. A failed insert
    // cannot invalidate a vendor thread. A clear invalidates the CAS below.
    const entry = await compactionEntryRepository.insert({
      sessionId, parentEntryId: history.checkpoint?.entryId ?? null,
      summary: result.summaryText, fileOps: result.fileOps,
      userInstructions: options.userInstructions ?? null,
      tokensBefore, tokensAfter, savingsRatio, messagesSummarized: prefix.length,
      triggerReason: manual ? 'force' : decision.allow ? decision.reason : 'force',
    });
    // Only the ROOT vendor conversations rotate onto the checkpoint, filtered
    // in this same statement: a child's per-task session never held the root
    // transcript, and children save outside this lock.
    const published = await sessionRepository.patchContextIfGeneration(sessionId, history.generation, {
      checkpoint: { generation: history.generation, through: { id: last.id, createdAt: last.createdAt.toISOString() },
        summary, fileOps: result.fileOps, entryId: entry.id },
      compactionState: { lastCompactedAt: new Date().toISOString(), lastCompactTokens: tokensBefore,
        lastSavingsRatio: savingsRatio, ineffectivePasses: 0, compactionIneffective: false },
      // Both vendors restart from this durable checkpoint. No unscoped vendor
      // maintenance subprocess, extra hidden bill, or concurrent /compact.
      nativeConversation: native && nativeTail ? { ...native, checkpointId: entry.id,
        messages: capNativeSnapshot([{ role: 'user', content: `[Conversation checkpoint]\n${summary}`, timestamp: last.createdAt.toISOString() }, ...nativeTail]) } : null,
    }, { keepCliSessionPrefixes: CHILD_CLI_SESSION_KEY_PREFIXES });
    if (published && extractsMemoryOnCompaction(getConfig().memory?.extractionCadence, audience)) {
      const { updateMemoriesAfterTurn } = await import('@/core/memory');
      const { turnWorkspaceId } = await import('./session-resolver');
      const { userId, workspaceId } = history.session;
      // Memories follow the session's workspace, as on every turn.
      void turnWorkspaceId(userId, workspaceId)
        .then(ws => updateMemoriesAfterTurn({ userId, workspaceId: ws, agentScope: null, userMessage: result.summaryText }))
        .catch(err => coreLogger.warn({ err, sessionId }, 'on-compaction memory update failed'));
    }
    if (published) coreLogger.info({ sessionId, tokensBefore, tokensAfter, savingsRatio }, 'Session checkpoint committed; vendor conversations rotated');
    return Boolean(published);
  });
}

/**
 * Compaction of a room (§6.4), inside the caller's conversation lock. A
 * room has no native snapshot and no vendor session; its history is the
 * attributed transcript after the checkpoint, so the pass is triggered by
 * that transcript's size (`rooms.transcriptWindowChars`) rather than by row
 * count, and the summary is made from the attributed rows themselves — the
 * checkpoint then covers exactly the rows it summarized, and the window
 * starts where it ends (no gap, no overlap). The summary call runs as the
 * requester, funded by the install; it never feeds memory extraction (a
 * room's words are not anyone's personal memories).
 */
async function compactRoom(sessionId: string, options: MaybeCompactSessionOptions): Promise<boolean> {
  if (!options.requesterId) throw new Error('Room compaction needs the requester of the turn that triggered it');
  const history = await readSessionHistory(sessionId);
  if (!history.session || history.rows.length < 2) return false;
  const { transcriptChars, renderRoomTranscript } = await import('@/core/rooms/room-context');
  const window = getConfig().rooms.transcriptWindowChars;
  const manual = Boolean(options.force || options.userInstructions);
  const chars = transcriptChars(history.rows);
  if (!manual && chars <= window) return false;
  // Keep the newest rows that fit in half the window verbatim (at least one),
  // summarize everything before them (at least one).
  let boundary = history.rows.length - 1;
  while (boundary > 1 && transcriptChars(history.rows.slice(boundary - 1)) <= window / 2) boundary--;
  const prefix = history.rows.slice(0, boundary);
  if (prefix.length === 0) return false;
  const model = await getModelRegistry().getDefaultModel();
  if (!model) throw new Error('No model configured for session compaction');
  const transcript = renderRoomTranscript({ roomTitle: history.session.title ?? 'Room', rows: prefix });
  const { withProviderUsageContext } = await import('@/models/providers/instrumented');
  const result = await withProviderUsageContext(
    { userId: options.requesterId, sessionId, workspaceId: history.session.workspaceId, funding: 'install' },
    () => createLLMSummary([{ role: 'user', content: transcript, timestamp: new Date() }], model.modelId, {
      previousSummary: history.checkpoint?.summary,
      previousFileOps: history.checkpoint?.fileOps,
      userInstructions: options.userInstructions,
      userId: options.requesterId,
      requireSuccess: true,
    }),
  );
  if (!result.summaryText.trim()) return false;
  const summary = result.message.content;
  const tokensBefore = Math.ceil(chars / 4);
  const tokensAfter = Math.ceil((summary.length + transcriptChars(history.rows.slice(boundary))) / 4);
  const savingsRatio = tokensBefore > 0 ? (tokensBefore - tokensAfter) / tokensBefore : 0;
  const last = prefix[prefix.length - 1];
  const entry = await compactionEntryRepository.insert({
    sessionId, parentEntryId: history.checkpoint?.entryId ?? null,
    summary: result.summaryText, fileOps: result.fileOps,
    userInstructions: options.userInstructions ?? null,
    tokensBefore, tokensAfter, savingsRatio, messagesSummarized: prefix.length,
    triggerReason: manual ? 'force' : 'room-window',
  });
  const published = await sessionRepository.patchContextIfGeneration(sessionId, history.generation, {
    checkpoint: { generation: history.generation, through: { id: last.id, createdAt: last.createdAt.toISOString() },
      summary, fileOps: result.fileOps, entryId: entry.id },
    compactionState: { lastCompactedAt: new Date().toISOString(), lastCompactTokens: tokensBefore,
      lastSavingsRatio: savingsRatio, ineffectivePasses: 0, compactionIneffective: false },
  });
  if (published) coreLogger.info({ sessionId, chars, summarized: prefix.length }, 'Room checkpoint committed');
  return Boolean(published);
}

/**
 * Whether a published checkpoint feeds memory extraction. Never for a
 * group-channel thread or a room (the summary carries other members' words,
 * which must not become the requester's personal memories), nor for a space
 * session (personal memories never touch a space, I7): `sessionAudience`.
 */
export function extractsMemoryOnCompaction(
  cadence: string | undefined,
  audience: Pick<SessionAudience, 'personalMemoryOff'>,
): boolean {
  return cadence === 'on_compaction' && !audience.personalMemoryOff;
}

/** Shared manual command for gateway and chat clients. */
export async function compactSessionCommand(sessionId: string | undefined, args: string): Promise<string> {
  if (!sessionId) return 'No active session to compact.';
  try {
    const instructions = args.trim();
    const cliResult = await withSessionConversation(sessionId, async () => {
      const session = await sessionRepository.findById(sessionId);
      return session ? compactCliConversation(session, instructions) : null;
    });
    if (cliResult) return cliResult;
    const compacted = await maybeCompactSession(sessionId, {
      force: true,
      userInstructions: instructions || undefined,
    });
    if (!compacted) return 'Session was not compacted: no summarizable history, an empty summary, or the session changed. Recent messages are preserved.';
    return 'Session compacted. Older messages summarized, recent messages preserved.';
  } catch (err) {
    return `Compaction failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
