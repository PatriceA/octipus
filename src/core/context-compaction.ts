import type { AgentMessage } from '@/core/types';

export interface CompactionResult {
  compactedMessages: AgentMessage[];
  summaryMessage: AgentMessage;
  removedCount: number;
  fileOperations: { read: string[]; written: string[]; edited: string[] };
}

/**
 * Merge two file-operation bags. De-duplicates per-bucket and preserves
 * insertion order (cumulative tracker — newest pass appended after older).
 */
export function mergeFileOperations(
  prev: CompactionResult['fileOperations'] | undefined,
  next: CompactionResult['fileOperations'],
): CompactionResult['fileOperations'] {
  const dedupe = (a: string[], b: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const x of [...a, ...b]) {
      if (!x) continue;
      if (seen.has(x)) continue;
      seen.add(x);
      out.push(x);
    }
    return out;
  };

  return {
    read: dedupe(prev?.read ?? [], next.read),
    written: dedupe(prev?.written ?? [], next.written),
    edited: dedupe(prev?.edited ?? [], next.edited),
  };
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
    const calls = m.toolCalls?.length ? `\nTool calls: ${JSON.stringify(m.toolCalls)}` : '';
    const tool = m.role === 'tool' ? ` (${m.name ?? m.toolCallId ?? 'result'})` : '';
    return `[${role}${tool}]: ${content}${calls}`;
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

export interface BuildSummarizationPromptOptions {
  /** Output budget of the summary call, which the length guidance follows. */
  budgetTokens?: number;
  /**
   * Summary text from the previous compaction pass. When present, the LLM
   * is asked to produce a *combined* summary that subsumes it rather than
   * starting fresh — this is the iterative-chaining pattern.
   */
  previousSummary?: string;
  /**
   * Free-form user input from `/compact <instructions>`. Threaded into the
   * prompt so the user can focus the summary (e.g. "focus on auth flow").
   */
  userInstructions?: string;
}

/**
 * The checkpoint's sections. A narrative "under 500 words" lost exactly what a
 * resumed agent needs — exact paths, commands, errors, the user's own
 * constraints — so the summary is structured, and the user's requests are kept
 * in their words.
 */
export const SUMMARY_STRUCTURE = `Use these sections, each as a short list; omit a section only if it has nothing:
1. What the user asked for — the goal and every request, in the user's own words where they matter
2. Constraints and preferences the user stated
3. Key decisions made, and why
4. What was accomplished — with exact file paths, commands, ids and results
5. Errors hit and how they were resolved (or not)
6. What's still pending or in progress — the next concrete step
7. Critical context — facts, values or identifiers the work cannot continue without`;

/** Length guidance sized to the history being replaced (`summaryBudgetTokens`). */
export function summaryLengthGuidance(budgetTokens?: number): string {
  const words = Math.round((budgetTokens ?? 700) * 0.7);
  return `Be complete but dense: at most about ${words} words. Write facts, not a conversation.`;
}

/**
 * Build the summarization prompt. Supports iterative chaining (carries
 * the previous summary forward) and user-supplied instructions.
 */
export function buildSummarizationPrompt(
  serialized: string,
  fileOps: CompactionResult['fileOperations'],
  options: BuildSummarizationPromptOptions = {},
): string {
  const sections: string[] = [];

  sections.push(`Summarize the following conversation between a user and an AI assistant.
${SUMMARY_STRUCTURE}`);

  if (options.userInstructions?.trim()) {
    sections.push(`User instructions for this summary (apply alongside the standard focus):
${options.userInstructions.trim()}`);
  }

  if (options.previousSummary?.trim()) {
    sections.push(`Previous summary (already covers earlier history — fold this into the new summary, do not repeat it verbatim and do not lose important facts from it):
---
${options.previousSummary.trim()}
---`);
  }

  sections.push(`Cumulative file activity across the whole session:
- Files read: ${fileOps.read.join(', ') || 'none'}
- Files written: ${fileOps.written.join(', ') || 'none'}
- Files edited: ${fileOps.edited.join(', ') || 'none'}`);

  sections.push(`${summaryLengthGuidance(options.budgetTokens)}

---
${serialized}
---

Summary:`);

  return sections.join('\n\n');
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
