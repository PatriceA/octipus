/**
 * Retrieved context is not repeated while an earlier copy is still in view.
 *
 * Each root turn's per-turn context (the volatile tier: date, long-term memory,
 * context-hook blocks, directives) rides in front of the user's message and is
 * stored with it (`metadata.promptContext`), so the replayed conversation is
 * byte-identical and stays cached. The cost was that a thirty-turn conversation
 * carried thirty copies of the same memory block and the same pinned note: the
 * window filled, compaction came sooner, and an old snippet competed with the
 * fresh one for attention.
 *
 * So a RETRIEVED block — never a directive, which is repeated on purpose — is
 * left out of this turn when an earlier user message still in the conversation
 * carries it verbatim, and one line says so. Earlier turns keep their bytes,
 * which is what the cache is keyed on. Once a checkpoint or compaction drops
 * the earlier copy, the block is no longer in view and comes back on the next
 * turn by itself; nothing has to remember what was shown.
 */

import type { AgentMessage } from '@/core/types';

/** `AgentContext.metadata` key: this turn's repeatable (retrieved) blocks, verbatim. */
export const REPEATABLE_CONTEXT_KEY = 'repeatableContext';

/** Shorter than this, a block costs less than the line that replaces it. */
const MIN_BLOCK_CHARS = 120;

export const REPEATED_CONTEXT_NOTE =
  'Context retrieved on an earlier turn of this conversation (long-term memory, pinned notes, documents) is still above and still applies; unchanged blocks are not repeated here.';

/**
 * `promptContext` without the `blocks` an earlier user message in `history`
 * already carries, plus `REPEATED_CONTEXT_NOTE` when any went.
 */
export function omitRepeatedContext(promptContext: string, blocks: readonly unknown[] | undefined, history: readonly AgentMessage[]): string {
  return withoutRepeatedContext(promptContext, blocks, history).text;
}

/** `omitRepeatedContext`, also naming the blocks it left out. */
export function withoutRepeatedContext(
  promptContext: string,
  blocks: readonly unknown[] | undefined,
  history: readonly AgentMessage[],
): { text: string; omitted: string[] } {
  const unchanged = { text: promptContext, omitted: [] };
  if (!promptContext || !blocks?.length) return unchanged;
  const earlier = userContents(history);
  if (!earlier.length) return unchanged;
  let out = promptContext;
  const omitted: string[] = [];
  for (const raw of blocks) {
    if (typeof raw !== 'string') continue;
    const block = raw.trim();
    if (block.length < MIN_BLOCK_CHARS || !out.includes(block)) continue;
    if (!earlier.some((content) => content.includes(block))) continue;
    out = out.replace(block, '');
    omitted.push(block);
  }
  if (!omitted.length) return unchanged;
  return { text: `${out.replace(/\n{3,}/g, '\n\n').trim()}\n\n${REPEATED_CONTEXT_NOTE}`, omitted };
}

/** This turn's user message as sent, and the blocks left out of it. */
export interface OmittedContext {
  content: string;
  omitted: string[];
}

/**
 * After an in-turn compaction: put back into this turn's user message every
 * omitted block that no other user message in `history` carries any more. The
 * decision to omit was made against the history at the start of the turn; a
 * compaction that summarizes the earlier copy would otherwise leave the note
 * pointing at nothing until the next turn. The compaction has already
 * rewritten the prefix, so changing this message costs no cache.
 *
 * The message is found by its content (a compaction may copy messages), and
 * rewritten in place. Returns the state to keep for the next compaction, or
 * undefined once nothing is left out (or the message itself was compacted).
 */
export function restoreOmittedContext(history: AgentMessage[], turn: OmittedContext): OmittedContext | undefined {
  const message = history.find((m) => m.role === 'user' && m.content === turn.content);
  if (!message) return undefined;
  const others = userContents(history.filter((m) => m !== message));
  const missing = turn.omitted.filter((block) => !others.some((content) => content.includes(block)));
  if (!missing.length) return turn;
  const still = turn.omitted.filter((block) => !missing.includes(block));
  const replacement = [missing.join('\n\n'), still.length ? REPEATED_CONTEXT_NOTE : ''].filter(Boolean).join('\n\n');
  message.content = turn.content.replace(REPEATED_CONTEXT_NOTE, replacement);
  return still.length ? { content: message.content, omitted: still } : undefined;
}

function userContents(history: readonly AgentMessage[]): string[] {
  return history
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content as string);
}
