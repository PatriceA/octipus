import { getConfig } from '@/config';
import { getGatewayHub } from '@/core/gateway/hub';
import type { AgentMessage } from '@/core/types';
import { compactionEntryRepository } from '@/db/repositories/compaction-entry-repository';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { CompactionFileOps } from '@/db/schema/compaction-entries';
import type { CompactionState, SessionContext } from '@/db/schema/sessions';
import { calculateTotalTokens, compactMessagesWithSummary } from '@/utils/context-compaction';
import { coreLogger } from '@/utils/logger';

const COMPACTION_MESSAGE_THRESHOLD = 20;
const COMPACTION_TOKEN_THRESHOLD = 8000;

/**
 * Savings ratio at/above which we clear a previously-set stall flag.
 * Intentionally higher than `minSavingsRatio` to require a clearly effective
 * pass before we re-enable continuous compaction.
 */
const STALL_RECOVERY_RATIO = 0.15;

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
export async function maybeCompactSession(
  sessionId: string,
  options: MaybeCompactSessionOptions = {},
): Promise<void> {
  const session = await sessionRepository.findById(sessionId);
  if (!session) return;

  const userTriggered = Boolean(options.userInstructions || options.force);

  if (!userTriggered) {
    const messageThresholdHit = session.messageCount >= COMPACTION_MESSAGE_THRESHOLD;
    const tokenThresholdHit = session.tokenCount >= COMPACTION_TOKEN_THRESHOLD;
    if (!messageThresholdHit && !tokenThresholdHit) return;
  }

  const { compaction: cfg } = getConfig();
  const context = (session.context as SessionContext) || {};
  const state = context.compactionState;

  const decision = decideCompaction({
    currentTokens: session.tokenCount,
    state,
    config: cfg,
  });

  if (!decision.allow && !options.force) {
    coreLogger.debug(
      {
        sessionId,
        currentTokens: session.tokenCount,
        nextEligibleTokens: decision.nextEligibleTokens,
        ineffectivePasses: state?.ineffectivePasses,
      },
      'Skipping compaction — stalled awaiting session growth',
    );
    return;
  }

  const triggerReason = decision.allow ? decision.reason : 'force';
  await compactSessionContext(sessionId, triggerReason, options.userInstructions, session.userId);
}

/**
 * Compact a session's message history into a summary stored in session
 * context. Records savings ratio, tracks ineffective passes, and emits a
 * `session.compaction_stalled` gateway event when a pass fails to free
 * enough tokens.
 *
 * Iterative chaining: when a previous `compaction_entries` row exists for
 * this session, its summary + cumulative file ops are threaded into the
 * new pass and a fresh structured row is appended.
 */
async function compactSessionContext(
  sessionId: string,
  allowReason: Exclude<CompactionDecision, { allow: false }>['reason'] | 'force',
  userInstructions?: string,
  userId?: string,
): Promise<void> {
  const messages = await messageRepository.findBySession(sessionId, 200, 0, ['user', 'assistant']);
  if (messages.length < 10) return;

  const agentMessages: AgentMessage[] = messages.map(m => ({
    role: m.role as 'user' | 'assistant' | 'system',
    content: m.content,
    timestamp: m.createdAt,
  }));

  const tokensBefore = calculateTotalTokens(agentMessages);

  // Pull the most recent structured entry to chain summaries iteratively.
  const previousEntry = await compactionEntryRepository.findLatest(sessionId).catch(() => undefined);

  const result = await compactMessagesWithSummary(agentMessages, {
    maxTokens: 4000,
    preserveRecentCount: 6,
    previousSummary: previousEntry?.summary,
    previousFileOps: previousEntry?.fileOps as CompactionFileOps | undefined,
    userInstructions,
    userId,
  });

  const tokensAfter = calculateTotalTokens(result.messages);
  const savingsRatio = tokensBefore > 0 ? (tokensBefore - tokensAfter) / tokensBefore : 0;

  const { compaction: cfg } = getConfig();
  const session = await sessionRepository.findById(sessionId);
  const existingContext = (session?.context as SessionContext) || {};
  const prevState: CompactionState = existingContext.compactionState || {};

  const ineffective = savingsRatio < cfg.minSavingsRatio;
  const recovered = savingsRatio >= STALL_RECOVERY_RATIO;

  const nextState: CompactionState = {
    lastCompactedAt: new Date().toISOString(),
    lastSavingsRatio: savingsRatio,
    lastCompactTokens: tokensBefore,
    ineffectivePasses: ineffective ? (prevState.ineffectivePasses || 0) + 1 : 0,
    // A clearly-effective pass clears the stall flag; a marginally-effective
    // pass (between minSavingsRatio and STALL_RECOVERY_RATIO) leaves the flag
    // in its prior state — it's neither bad enough to stall nor good enough
    // to trust fully.
    compactionIneffective: ineffective
      ? true
      : recovered
        ? false
        : prevState.compactionIneffective,
  };

  const summaryMsg = result.messages.find(m => m.role === 'system' && m.content.startsWith('Summary'));

  // Context.compactedSummary is the legacy single-string field;
  // compaction_entries is the new append-only log. Readers should pull
  // from the latest compaction_entries row (see service.ts /
  // direct-response.ts). We stop writing to compactedSummary here —
  // commands/clear.ts still nulls it for the old-data case.
  await sessionRepository.update(sessionId, {
    context: {
      ...existingContext,
      compactionState: nextState,
    },
  });

  // Persist a structured CompactionEntry when the summarizer produced one.
  // The structured-result variant of `compactMessagesWithSummary` only
  // populates `summaryText`/`fileOps` when chaining/instructions were used,
  // so we synthesize from `summaryMsg` for the first-pass case.
  const structuredSummary = result.summaryText
    ?? (summaryMsg?.content && summaryMsg.content.replace(/^\[Context Summary[^\]]*\]\s*/, '').split('\n\nFiles ')[0])
    ?? '';
  const structuredFileOps = result.fileOps ?? { read: [], written: [], edited: [] };

  if (structuredSummary.trim().length > 0) {
    try {
      await compactionEntryRepository.insert({
        sessionId,
        parentEntryId: previousEntry?.id ?? null,
        summary: structuredSummary,
        fileOps: structuredFileOps,
        userInstructions: userInstructions ?? null,
        tokensBefore,
        tokensAfter,
        savingsRatio,
        messagesSummarized: result.removed,
        triggerReason: allowReason,
      });
    } catch (err) {
      coreLogger.warn({ err, sessionId }, 'Failed to persist compaction entry (non-fatal)');
    }
  }

  coreLogger.info(
    {
      sessionId,
      removed: result.removed,
      tokensBefore,
      tokensAfter,
      savingsRatio,
      ineffectivePasses: nextState.ineffectivePasses,
      allowReason,
    },
    'Session context compacted',
  );

  if (ineffective) {
    const nextEligibleTokens = Math.ceil(tokensBefore * cfg.growthMultiplier);
    coreLogger.warn(
      {
        sessionId,
        savingsRatio,
        ineffectivePasses: nextState.ineffectivePasses,
        nextEligibleTokens,
      },
      'Compaction pass ineffective — stalling further passes until session grows',
    );

    try {
      const hub = getGatewayHub();
      hub.publishEvent({
        type: 'session.compaction_stalled',
        source: 'session-compaction',
        sessionId,
        userId: session?.userId,
        payload: {
          sessionId,
          ratio: savingsRatio,
          ineffectivePasses: nextState.ineffectivePasses,
          nextEligibleTokens,
        },
      });
    } catch (err) {
      // Gateway may not be running in tests or during shutdown — don't let
      // that block the compaction state from being persisted.
      coreLogger.debug({ err, sessionId }, 'Failed to emit session.compaction_stalled event');
    }
  }
}
