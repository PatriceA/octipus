import {
  buildSummarizationPrompt,
  extractFileOperations,
  serializeConversation,
} from '@/core/context-compaction';
import type { AgentMessage } from '@/core/types';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';

export type { CompactionResult } from '@/core/context-compaction';
// Re-export for convenience
export { compactWithSummarization, extractFileOperations } from '@/core/context-compaction';

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

/**
 * Estimate token count for a message (rough approximation)
 * Uses ~4 characters per token as a heuristic
 */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

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
  const assistantMessages = removedMessages.filter(m => m.role === 'assistant').length;
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
      `They included ${userMessages} user messages, ${assistantMessages} assistant responses, ` +
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

/**
 * Create an LLM-generated summary of removed messages.
 * Uses file-operation-aware summarization for richer context preservation.
 * Falls back to createSummaryMessage() on error.
 */
export async function createLLMSummary(
  removedMessages: AgentMessage[],
  summaryModel: string
): Promise<AgentMessage> {
  try {
    const client = getLiteLLMClient();

    // Use the richer serialization and file-operation extraction
    const fileOps = extractFileOperations(removedMessages);
    const serialized = serializeConversation(removedMessages);
    const prompt = buildSummarizationPrompt(serialized.slice(0, 8000), fileOps);

    const result = await client.complete({
      model: summaryModel,
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

    return {
      role: 'system',
      content: `[Context Summary - ${removedMessages.length} earlier messages compacted]\n\n${result.content}${fileOpsSection ? '\n\n' + fileOpsSection : ''}`,
      timestamp: new Date(),
    };
  } catch {
    // Fall back to keyword-based summary
    return createSummaryMessage(removedMessages);
  }
}

/**
 * Compact messages and generate an LLM summary for removed messages.
 */
export async function compactMessagesWithSummary(
  messages: AgentMessage[],
  options: CompactionOptions = {}
): Promise<{ messages: AgentMessage[]; removed: number }> {
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
  const summary = await createLLMSummary(nonSystemRemoved, model);

  // Insert summary after system messages
  const systemMessages = compactedMessages.filter((m) => m.role === 'system');
  const otherMessages = compactedMessages.filter((m) => m.role !== 'system');

  return {
    messages: [...systemMessages, summary, ...otherMessages],
    removed,
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
