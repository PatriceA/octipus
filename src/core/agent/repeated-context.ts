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
  if (!promptContext || !blocks?.length) return promptContext;
  const earlier = history
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content as string);
  if (!earlier.length) return promptContext;
  let out = promptContext;
  let omitted = 0;
  for (const raw of blocks) {
    if (typeof raw !== 'string') continue;
    const block = raw.trim();
    if (block.length < MIN_BLOCK_CHARS || !out.includes(block)) continue;
    if (!earlier.some((content) => content.includes(block))) continue;
    out = out.replace(block, '');
    omitted++;
  }
  if (!omitted) return promptContext;
  return `${out.replace(/\n{3,}/g, '\n\n').trim()}\n\n${REPEATED_CONTEXT_NOTE}`;
}
