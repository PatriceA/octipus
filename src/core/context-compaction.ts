import type { AgentMessage } from '@/core/types';

export interface CompactionResult {
  compactedMessages: AgentMessage[];
  summaryMessage: AgentMessage;
  removedCount: number;
  fileOperations: { read: string[]; written: string[]; edited: string[] };
}

/**
 * Serialize a conversation window into text for summarization.
 * Format prevents the LLM from "continuing" the conversation.
 */
export function serializeConversation(messages: AgentMessage[]): string {
  return messages.map((m) => {
    const role = m.role.toUpperCase();
    const content = typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content);
    return `[${role}]: ${content}`;
  }).join('\n\n');
}

/**
 * Extract file operation metadata from messages for preservation.
 */
export function extractFileOperations(messages: AgentMessage[]): CompactionResult['fileOperations'] {
  const ops = { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };

  for (const msg of messages) {
    if (msg.role !== 'tool') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    // Detect file operations from tool results
    const readMatch = content.match(/Read file:?\s*([^\n]+)/gi);
    const writeMatch = content.match(/(?:Wrote|Created|Written to):?\s*([^\n]+)/gi);
    const editMatch = content.match(/(?:Edited|Modified|Updated):?\s*([^\n]+)/gi);
    readMatch?.forEach(m => ops.read.add(m.replace(/^Read file:?\s*/i, '').trim()));
    writeMatch?.forEach(m => ops.written.add(m.replace(/^(?:Wrote|Created|Written to):?\s*/i, '').trim()));
    editMatch?.forEach(m => ops.edited.add(m.replace(/^(?:Edited|Modified|Updated):?\s*/i, '').trim()));
  }

  return {
    read: [...ops.read],
    written: [...ops.written],
    edited: [...ops.edited],
  };
}

/**
 * Build the summarization prompt.
 */
export function buildSummarizationPrompt(serialized: string, fileOps: CompactionResult['fileOperations']): string {
  return `Summarize the following conversation between a user and an AI assistant.
Focus on:
1. What the user asked for
2. Key decisions made
3. What was accomplished
4. What's still pending or in progress

Files read: ${fileOps.read.join(', ') || 'none'}
Files written: ${fileOps.written.join(', ') || 'none'}
Files edited: ${fileOps.edited.join(', ') || 'none'}

Keep the summary concise (under 500 words). Write as a factual narrative, not as a conversation.

---
${serialized}
---

Summary:`;
}

/**
 * Compact old messages by summarizing them with an LLM.
 * Keeps the most recent `keepRecent` messages intact.
 */
export async function compactWithSummarization(
  messages: AgentMessage[],
  summarize: (prompt: string) => Promise<string>,
  keepRecent: number = 20,
): Promise<CompactionResult> {
  if (messages.length <= keepRecent) {
    return {
      compactedMessages: messages,
      summaryMessage: { role: 'system', content: '', timestamp: new Date() },
      removedCount: 0,
      fileOperations: { read: [], written: [], edited: [] },
    };
  }

  const toSummarize = messages.slice(0, messages.length - keepRecent);
  const toKeep = messages.slice(messages.length - keepRecent);

  const fileOps = extractFileOperations(toSummarize);
  const serialized = serializeConversation(toSummarize);
  const prompt = buildSummarizationPrompt(serialized, fileOps);

  const summary = await summarize(prompt);

  const summaryMessage: AgentMessage = {
    role: 'system',
    content: `[Context Summary - ${toSummarize.length} messages compacted]\n\n${summary}\n\nFiles read: ${fileOps.read.join(', ') || 'none'}\nFiles written: ${fileOps.written.join(', ') || 'none'}\nFiles edited: ${fileOps.edited.join(', ') || 'none'}`,
    timestamp: new Date(),
  };

  return {
    compactedMessages: [summaryMessage, ...toKeep],
    summaryMessage,
    removedCount: toSummarize.length,
    fileOperations: fileOps,
  };
}
