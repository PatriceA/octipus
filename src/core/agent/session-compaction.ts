import { getConfig } from '@/config';
import { capNativeSnapshot, readSessionHistory, toContextMessage, withSessionConversation } from '@/core/session-history';
import { getModelRegistry } from '@/models/model-registry';
import { getGatewayHub } from '@/core/gateway/hub';
import { compactionEntryRepository } from '@/db/repositories/compaction-entry-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { CompactionState, } from '@/db/schema/sessions';
import { calculateTotalTokens, createLLMSummary } from '@/utils/context-compaction';
import { coreLogger } from '@/utils/logger';

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
   * threshold checks (the user explicitly asked to compact) but still
   * respects the stall guard unless `force` is set.
   */
  userInstructions?: string;
  /** Bypass the anti-thrashing stall guard. Used by manual `/compact`. */
  force?: boolean;
}

/**
 * Check if a session needs compaction and trigger it if so.
 *
 * Respects the anti-thrashing guard: if the prior pass was ineffective we
 * skip further passes until the session has grown by `growthMultiplier` ×
 * the previous pre-compact size, or the token count hits the hard ceiling.
 */
export async function maybeCompactSession(sessionId: string, options: MaybeCompactSessionOptions = {}): Promise<void> {
  await withSessionConversation(sessionId, async () => {
    const history = await readSessionHistory(sessionId);
    if (!history.session || history.rows.length < 2) return;
    const savedNative = history.session.context?.nativeConversation;
    const acknowledgedIndex = savedNative ? history.rows.findIndex(row => row.id === savedNative.acknowledged.id) : -1;
    const activeMessages = savedNative?.generation === history.generation && savedNative.checkpointId === history.checkpoint?.entryId
      ? [...savedNative.messages.map(m => ({ ...m, timestamp: new Date(m.timestamp) })), ...history.rows.slice(acknowledgedIndex + 1).map(toContextMessage)]
      : history.messages;
    const tokensBefore = calculateTotalTokens(activeMessages);
    const manual = Boolean(options.force || options.userInstructions);
    if (!manual && history.rows.length < COMPACTION_MESSAGE_THRESHOLD && tokensBefore < COMPACTION_TOKEN_THRESHOLD) return;
    const cfg = getConfig().compaction;
    const state = history.session.context?.compactionState;
    const decision = decideCompaction({ currentTokens: tokensBefore, state, config: cfg });
    if (!manual && !decision.allow) return;
    // Summarize a contiguous prefix. Retain its exact suffix, never an unrelated
    // original-user anchor that makes coverage ambiguous.
    // Retain complete user/answer pairs so native tool sequences are not split.
    let boundary = Math.max(1, history.rows.length - 6);
    while (boundary < history.rows.length && history.rows[boundary].role !== 'user') boundary++;
    if (boundary === history.rows.length) return;
    const keep = history.rows.length - boundary;
    const prefix = history.rows.slice(0, boundary);
    if (!prefix.length) return;
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
    if (!result.summaryText.trim()) return;
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
      return;
    }
    const last = prefix[prefix.length - 1];
    // Persist the audit entry before publishing its checkpoint. A failed insert
    // cannot invalidate a vendor thread. A clear invalidates the CAS below.
    const entry = await compactionEntryRepository.insert({
      sessionId, parentEntryId: history.checkpoint?.entryId ?? null,
      summary: result.summaryText, fileOps: result.fileOps,
      userInstructions: options.userInstructions ?? null,
      tokensBefore, tokensAfter, savingsRatio, messagesSummarized: prefix.length,
      triggerReason: manual ? 'force' : decision.allow ? decision.reason : 'force',
    });
    const published = await sessionRepository.patchContextIfGeneration(sessionId, history.generation, {
      checkpoint: { generation: history.generation, through: { id: last.id, createdAt: last.createdAt.toISOString() },
        summary, fileOps: result.fileOps, entryId: entry.id },
      compactionState: { lastCompactedAt: new Date().toISOString(), lastCompactTokens: tokensBefore,
        lastSavingsRatio: savingsRatio, ineffectivePasses: 0, compactionIneffective: false },
      // Both vendors restart from this durable checkpoint. No unscoped vendor
      // maintenance subprocess, extra hidden bill, or concurrent /compact.
      cliSessions: {},
      nativeConversation: native && nativeTail ? { ...native, checkpointId: entry.id,
        messages: capNativeSnapshot([{ role: 'user', content: `[Conversation checkpoint]\n${summary}`, timestamp: last.createdAt.toISOString() }, ...nativeTail]) } : null,
    });
    if (published && getConfig().memory?.extractionCadence === 'on_compaction') {
      const { updateMemoriesAfterTurn } = await import('@/core/memory');
      void updateMemoriesAfterTurn({ userId: history.session.userId, workspaceId: null, agentScope: null, userMessage: result.summaryText })
        .catch(err => coreLogger.warn({ err, sessionId }, 'on-compaction memory update failed'));
    }
    if (published) coreLogger.info({ sessionId, tokensBefore, tokensAfter, savingsRatio }, 'Session checkpoint committed; vendor conversations rotated');
  });
}
