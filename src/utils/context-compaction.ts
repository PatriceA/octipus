import {
  buildSummarizationPrompt,
  extractFileOperations,
  mergeFileOperations,
  serializeConversation,
} from '@/core/context-compaction';
import type { AgentMessage } from '@/core/types';
import type { CompletionOptions } from '@/models/litellm-client';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';
import { estimateTokens } from '@/utils/token-count';

// Summarizer input sizing. A single pass reads at most SUMMARY_INPUT_CHARS; a
// longer history is condensed by a bounded map-reduce (chunk → summarize each →
// summarize the summaries) instead of the old silent slice(0, 8000) that
// dropped everything past the first ~8 KB.
const SUMMARY_INPUT_CHARS = 8000;
const MAX_MAP_CHUNKS = 8;

/**
 * Condense a serialized conversation down to <= SUMMARY_INPUT_CHARS while
 * keeping fidelity across the WHOLE history. Short input passes through
 * unchanged (single-pass behavior). Longer input is chunked and each chunk
 * summarized (map); the joined partial summaries become the reduce-pass input.
 * Bounded to MAX_MAP_CHUNKS map calls; if the history still overflows that, the
 * tail is dropped with a loud warning (fail loud — never a silent slice).
 */
async function condenseForSummary(
  serialized: string,
  summaryModel: string,
  userId: string | undefined,
): Promise<string> {
  if (serialized.length <= SUMMARY_INPUT_CHARS) return serialized;

  const client = getLiteLLMClient();
  const chunks: string[] = [];
  for (let i = 0; i < serialized.length && chunks.length < MAX_MAP_CHUNKS; i += SUMMARY_INPUT_CHARS) {
    chunks.push(serialized.slice(i, i + SUMMARY_INPUT_CHARS));
  }
  const covered = chunks.length * SUMMARY_INPUT_CHARS;
  if (serialized.length > covered) {
    coreLogger.warn(
      { totalChars: serialized.length, coveredChars: covered, maxChunks: MAX_MAP_CHUNKS },
      'summarizer: history exceeds map-reduce cap — tail truncated (was a silent slice before)',
    );
  }

  const mapOpts = (chunk: string): CompletionOptions => ({
    model: summaryModel,
    userId,
    messages: [
      {
        role: 'system',
        content:
          'Summarize this conversation excerpt in a few factual sentences ' +
          '(decisions, actions, outcomes). Do not continue the conversation.',
        timestamp: new Date(),
      },
      { role: 'user', content: chunk, timestamp: new Date() },
    ],
    temperature: 0.3,
    maxTokens: 250,
  });

  const partials = await Promise.all(
    chunks.map(async (chunk, idx) => {
      const res = await client.complete(mapOpts(chunk));
      return `[Part ${idx + 1}] ${res.content}`;
    }),
  );
  return partials.join('\n\n');
}

export type { CompactionResult } from '@/core/context-compaction';
// Re-export for convenience
export { compactWithSummarization, extractFileOperations, mergeFileOperations } from '@/core/context-compaction';

interface CompactionOptions {
  maxMessages?: number;
  maxTokens?: number;
  preserveSystemMessages?: boolean;
  preserveRecentCount?: number;
  summaryModel?: string;
}

const DEFAULT_OPTIONS: CompactionOptions = {
  maxMessages: 100,
  maxTokens: 32000,
  preserveSystemMessages: true,
  preserveRecentCount: 10,
};

// Tokenizer lives in a standalone module so lighter call sites can reuse it;
// re-exported here for the existing import surface.
export { estimateTokens } from '@/utils/token-count';

/**
 * Calculate total token count for messages
 */
export function calculateTotalTokens(messages: AgentMessage[]): number {
  return messages.reduce((total, msg) => {
    let tokens = estimateTokens(msg.content);
    if (msg.toolCalls) {
      tokens += estimateTokens(JSON.stringify(msg.toolCalls));
    }
    return total + tokens;
  }, 0);
}

/** Default soft cap on full tool-result messages kept in context. */
export const DEFAULT_TOOL_OUTPUT_SOFT_CAP = 10;

/** Max chars retained per truncated tool output (mirrors the reactive-overflow idiom). */
const TOOL_OUTPUT_TRUNCATE_CHARS = 2000;

/** Marker appended to a truncated tool output — also the idempotency guard. */
const TOOL_OUTPUT_TRUNCATED_MARKER = '\n\n[... older tool output truncated to keep context small]';

/**
 * Marker the reactive (ContextWindowExceeded) path uses when it truncates tool
 * content. Exported so the agent loop and the idempotency guard share one
 * source of truth — a tool output truncated by either path is recognized as
 * already-truncated and never re-folded.
 */
export const CONTEXT_OVERFLOW_TRUNCATED_MARKER = '\n\n[... truncated due to context window limit]';

/**
 * Tool-output-targeted compaction: once there are more than `softCap` tool-result
 * messages in context, truncate the OLDEST ones (keeping the most recent `softCap`
 * full) to a fixed char budget. Cheaper and far less destructive than whole-history
 * summarization, and it triggers earlier so context-overflow errors are rarer.
 *
 * - Only `role === 'tool'` messages are touched; assistant/user/system turns are
 *   left intact, so the model keeps its reasoning and the recent tool outputs full.
 * - Idempotent: an already-truncated output (ends with the marker) is skipped, so
 *   re-running each iteration does NOT double-fold or re-count.
 * - Returns a new array only when something changed; otherwise the original is
 *   returned unchanged with `truncated: 0`.
 */
export function truncateOldestToolOutputs(
  messages: AgentMessage[],
  opts: { softCap?: number; maxToolChars?: number } = {},
): { messages: AgentMessage[]; truncated: number } {
  const softCap = opts.softCap ?? DEFAULT_TOOL_OUTPUT_SOFT_CAP;
  const maxToolChars = opts.maxToolChars ?? TOOL_OUTPUT_TRUNCATE_CHARS;

  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') toolIndices.push(i);
  }
  if (toolIndices.length <= softCap) return { messages, truncated: 0 };

  // Oldest tool outputs above the cap are candidates; keep the most recent `softCap`.
  const candidates = toolIndices.slice(0, toolIndices.length - softCap);
  const result = [...messages];
  let truncated = 0;

  for (const idx of candidates) {
    const msg = result[idx];
    const content = msg.content;
    // Nothing to gain on already-small outputs, and skip already-truncated ones
    // (the marker check is what prevents a double-fold loop on repeated calls).
    // Recognize BOTH markers so a tool output the reactive overflow path already
    // truncated isn't re-folded here with a different marker.
    if (content.length <= maxToolChars) continue;
    if (content.endsWith(TOOL_OUTPUT_TRUNCATED_MARKER) || content.endsWith(CONTEXT_OVERFLOW_TRUNCATED_MARKER)) continue;
    result[idx] = { ...msg, content: content.slice(0, maxToolChars) + TOOL_OUTPUT_TRUNCATED_MARKER };
    truncated++;
  }

  return truncated > 0 ? { messages: result, truncated } : { messages, truncated: 0 };
}

/**
 * Group messages into atomic units that must stay together:
 * - assistant message with toolCalls + all following tool result messages
 * - standalone messages (user, assistant without tools, etc.)
 */
function groupAtomicBlocks(messages: AgentMessage[]): AgentMessage[][] {
  const blocks: AgentMessage[][] = [];
  let current: AgentMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'tool') {
      // Tool results always attach to the current block (assistant+toolCalls)
      current.push(msg);
    } else {
      // Flush previous block
      if (current.length > 0) {
        blocks.push(current);
      }
      current = [msg];
    }
  }
  if (current.length > 0) {
    blocks.push(current);
  }
  return blocks;
}

/**
 * Compact message history by removing old messages while preserving context.
 * Tool call/result pairs are kept together as atomic blocks to prevent
 * orphaned tool messages that cause LLM API errors.
 */
export function compactMessages(
  messages: AgentMessage[],
  options: CompactionOptions = {}
): { messages: AgentMessage[]; removed: number } {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (messages.length <= (opts.maxMessages || 100)) {
    const totalTokens = calculateTotalTokens(messages);
    if (totalTokens <= (opts.maxTokens || 32000)) {
      return { messages, removed: 0 };
    }
  }

  const systemMessages: AgentMessage[] = [];
  const otherMessages: AgentMessage[] = [];

  // Separate system messages if preserving them
  for (const msg of messages) {
    if (opts.preserveSystemMessages && msg.role === 'system') {
      systemMessages.push(msg);
    } else {
      otherMessages.push(msg);
    }
  }

  // Group into atomic blocks (assistant+toolCalls + tool results stay together)
  const blocks = groupAtomicBlocks(otherMessages);

  // Count individual messages to determine the split point
  const recentCount = opts.preserveRecentCount || 10;
  let recentMsgCount = 0;
  let splitIdx = blocks.length;
  for (let i = blocks.length - 1; i >= 0; i--) {
    recentMsgCount += blocks[i].length;
    if (recentMsgCount >= recentCount) {
      splitIdx = i;
      break;
    }
  }

  const recentBlocks = blocks.slice(splitIdx);
  const olderBlocks = blocks.slice(0, splitIdx);

  const recentMessages = recentBlocks.flat();

  // Calculate how many older blocks we can keep
  const systemTokens = calculateTotalTokens(systemMessages);
  const recentTokens = calculateTotalTokens(recentMessages);
  const remainingTokenBudget = (opts.maxTokens || 32000) - systemTokens - recentTokens;

  // Keep older blocks that fit in the budget (most recent first)
  const keptOlderMessages: AgentMessage[] = [];
  let usedTokens = 0;

  for (let i = olderBlocks.length - 1; i >= 0; i--) {
    const block = olderBlocks[i];
    const blockTokens = calculateTotalTokens(block);

    if (usedTokens + blockTokens <= remainingTokenBudget) {
      keptOlderMessages.unshift(...block);
      usedTokens += blockTokens;
    } else {
      break;
    }
  }

  const compactedMessages = [
    ...systemMessages,
    ...keptOlderMessages,
    ...recentMessages,
  ];

  return {
    messages: compactedMessages,
    removed: messages.length - compactedMessages.length,
  };
}

/**
 * Create a summary of removed messages (for context preservation)
 */
export function createSummaryMessage(removedMessages: AgentMessage[]): AgentMessage {
  const userMessages = removedMessages.filter(m => m.role === 'user').length;
  const octiMessages = removedMessages.filter(m => m.role === 'assistant').length;
  const toolMessages = removedMessages.filter(m => m.role === 'tool').length;

  // Extract key topics from messages
  const topics = new Set<string>();
  for (const msg of removedMessages) {
    // Simple keyword extraction
    const words = msg.content.toLowerCase().split(/\s+/);
    for (const word of words) {
      if (word.length > 5 && !['which', 'where', 'there', 'their', 'would', 'could', 'should'].includes(word)) {
        topics.add(word);
      }
    }
  }

  const topicList = Array.from(topics).slice(0, 10).join(', ');

  return {
    role: 'system',
    content: `[Context Summary: ${removedMessages.length} earlier messages were compacted. ` +
      `They included ${userMessages} user messages, ${octiMessages} assistant responses, ` +
      `and ${toolMessages} tool interactions. Key topics: ${topicList}]`,
    timestamp: new Date(),
  };
}

/**
 * Sliding window compaction strategy
 */
export function slidingWindowCompact(
  messages: AgentMessage[],
  windowSize: number = 50
): AgentMessage[] {
  if (messages.length <= windowSize) {
    return messages;
  }

  // Keep system messages and last windowSize messages
  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystemMessages = messages.filter(m => m.role !== 'system');
  const recentMessages = nonSystemMessages.slice(-windowSize);

  return [...systemMessages, ...recentMessages];
}

export interface CreateLLMSummaryOptions {
  /** Previous compaction's summary, threaded in for iterative chaining. */
  previousSummary?: string;
  /** Previous compaction's cumulative file operations — merged with current pass's. */
  previousFileOps?: { read: string[]; written: string[]; edited: string[] };
  /** Free-form `/compact <instructions>` payload. */
  userInstructions?: string;
  /** Calling user — threaded so providers can resolve user-scoped vault keys. */
  userId?: string;
}

export interface CreateLLMSummaryResult {
  message: AgentMessage;
  /** The raw summary text (no file-ops appendix), suitable for storing in a CompactionEntry. */
  summaryText: string;
  /** Cumulative file ops after merging previous + current. */
  fileOps: { read: string[]; written: string[]; edited: string[] };
}

/**
 * Create an LLM-generated summary of removed messages.
 * Uses file-operation-aware summarization for richer context preservation.
 * Falls back to createSummaryMessage() on error.
 *
 * Backwards-compatible: when called without `options`, returns the same
 * AgentMessage shape as before (signature uses overloads below).
 */
export async function createLLMSummary(
  removedMessages: AgentMessage[],
  summaryModel: string,
): Promise<AgentMessage>;
export async function createLLMSummary(
  removedMessages: AgentMessage[],
  summaryModel: string,
  options: CreateLLMSummaryOptions,
): Promise<CreateLLMSummaryResult>;
export async function createLLMSummary(
  removedMessages: AgentMessage[],
  summaryModel: string,
  options?: CreateLLMSummaryOptions,
): Promise<AgentMessage | CreateLLMSummaryResult> {
  try {
    const client = getLiteLLMClient();

    // Cumulative file ops = previous bag merged with current pass's extracted ops
    const currentOps = extractFileOperations(removedMessages);
    const fileOps = options?.previousFileOps
      ? mergeFileOperations(options.previousFileOps, currentOps)
      : currentOps;

    const serialized = serializeConversation(removedMessages);
    // Map-reduce condense so long histories keep fidelity instead of losing
    // everything past the first ~8 KB to a silent slice.
    const condensed = await condenseForSummary(serialized, summaryModel, options?.userId);
    const prompt = buildSummarizationPrompt(condensed, fileOps, {
      previousSummary: options?.previousSummary,
      userInstructions: options?.userInstructions,
    });

    const result = await client.complete({
      model: summaryModel,
      userId: options?.userId,
      messages: [
        {
          role: 'system',
          content:
            'You are a conversation summarizer. Produce a concise factual summary. ' +
            'Do not continue the conversation. Focus on decisions, actions, and outcomes.',
          timestamp: new Date(),
        },
        {
          role: 'user',
          content: prompt,
          timestamp: new Date(),
        },
      ],
      temperature: 0.3,
      maxTokens: 500,
    });

    const fileOpsSection = [
      fileOps.read.length > 0 ? `Files read: ${fileOps.read.join(', ')}` : null,
      fileOps.written.length > 0 ? `Files written: ${fileOps.written.join(', ')}` : null,
      fileOps.edited.length > 0 ? `Files edited: ${fileOps.edited.join(', ')}` : null,
    ].filter(Boolean).join('\n');

    const message: AgentMessage = {
      role: 'system',
      content: `[Context Summary - ${removedMessages.length} earlier messages compacted]\n\n${result.content}${fileOpsSection ? '\n\n' + fileOpsSection : ''}`,
      timestamp: new Date(),
    };

    if (options) {
      return { message, summaryText: result.content, fileOps };
    }
    return message;
  } catch {
    // Fall back to keyword-based summary
    const fallback = createSummaryMessage(removedMessages);
    if (options) {
      const merged = options.previousFileOps
        ? mergeFileOperations(options.previousFileOps, extractFileOperations(removedMessages))
        : extractFileOperations(removedMessages);
      return { message: fallback, summaryText: fallback.content, fileOps: merged };
    }
    return fallback;
  }
}

/**
 * Compact messages and generate an LLM summary for removed messages.
 *
 * When `options.previousSummary`, `options.previousFileOps`, or
 * `options.userInstructions` is provided, the returned object includes
 * `summaryText` and `fileOps` for callers that want to persist a
 * structured CompactionEntry.
 */
export interface CompactMessagesWithSummaryOptions extends CompactionOptions, CreateLLMSummaryOptions {}

export async function compactMessagesWithSummary(
  messages: AgentMessage[],
  options: CompactMessagesWithSummaryOptions = {}
): Promise<{
  messages: AgentMessage[];
  removed: number;
  summaryText?: string;
  fileOps?: { read: string[]; written: string[]; edited: string[] };
}> {
  const { messages: compactedMessages, removed } = compactMessages(messages, options);

  if (removed === 0) {
    return { messages: compactedMessages, removed };
  }

  // Get the removed messages for summarization
  const removedMessages = messages.slice(0, messages.length - compactedMessages.length);
  const nonSystemRemoved = removedMessages.filter((m) => m.role !== 'system');

  if (nonSystemRemoved.length === 0) {
    return { messages: compactedMessages, removed };
  }

  let model = options.summaryModel;
  if (!model) {
    const registry = getModelRegistry();
    const defaultModel = await registry.getDefaultModel();
    if (!defaultModel) {
      throw new Error('No default model configured for context compaction. Set one in the Models page.');
    }
    model = defaultModel.modelId;
  }

  // Detect iterative-summary intent to pick the structured-result overload.
  const iterative = Boolean(options.previousSummary || options.previousFileOps || options.userInstructions);

  let summary: AgentMessage;
  let summaryText: string | undefined;
  let mergedFileOps: { read: string[]; written: string[]; edited: string[] } | undefined;

  if (iterative) {
    const result = await createLLMSummary(nonSystemRemoved, model, {
      previousSummary: options.previousSummary,
      previousFileOps: options.previousFileOps,
      userInstructions: options.userInstructions,
      userId: options.userId,
    });
    summary = result.message;
    summaryText = result.summaryText;
    mergedFileOps = result.fileOps;
  } else {
    summary = await createLLMSummary(nonSystemRemoved, model);
  }

  // Insert summary after system messages
  const systemMessages = compactedMessages.filter((m) => m.role === 'system');
  const otherMessages = compactedMessages.filter((m) => m.role !== 'system');

  return {
    messages: [...systemMessages, summary, ...otherMessages],
    removed,
    summaryText,
    fileOps: mergedFileOps,
  };
}

/**
 * Group related messages (e.g., tool call and its result)
 */
export function groupRelatedMessages(messages: AgentMessage[]): AgentMessage[][] {
  const groups: AgentMessage[][] = [];
  let currentGroup: AgentMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
        currentGroup = [];
      }
      groups.push([msg]);
    } else if (msg.role === 'user') {
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = [msg];
    } else {
      currentGroup.push(msg);
    }
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}
