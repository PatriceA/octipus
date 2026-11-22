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
 *
 * A block can also be a group repeated per part (`RepeatableGroup`): the
 * recall block, whose passages each keep their bytes, so a passage still in
 * view is left out while a new one of the same turn is sent.
 */

import type { AgentMessage } from '@/core/types';
import { coreLogger } from '@/utils/logger';

/** `AgentContext.metadata` key: this turn's repeatable (retrieved) blocks, verbatim. */
export const REPEATABLE_CONTEXT_KEY = 'repeatableContext';

/**
 * A fenced block whose parts repeat separately: the recall block, whose
 * passages each keep their bytes from turn to turn. `head + parts.join('') +
 * tail` is the block as it stands in the turn's context. A part an earlier
 * turn still carries is left out; when every part is, the fence goes too, so
 * no empty shell is sent.
 */
export interface RepeatableGroup {
  head: string;
  tail: string;
  parts: string[];
}

/** One entry of `REPEATABLE_CONTEXT_KEY`: a whole block, or a group repeated per part. */
export type RepeatableBlock = string | RepeatableGroup;

/** Parts left out of one group, with the group's fence, so a restore puts them back inside it. */
export interface OmittedFence {
  head: string;
  tail: string;
  parts: string[];
}

/** Shorter than this, a block costs less than the line that replaces it. */
const MIN_BLOCK_CHARS = 120;

export const REPEATED_CONTEXT_NOTE =
  'Context retrieved on an earlier turn of this conversation (long-term memory, pinned notes, documents) is still above and still applies; unchanged blocks are not repeated here.';

function isGroup(raw: unknown): raw is RepeatableGroup {
  if (!raw || typeof raw !== 'object') return false;
  const g = raw as Partial<RepeatableGroup>;
  return typeof g.head === 'string' && typeof g.tail === 'string' && Array.isArray(g.parts) && g.parts.every((p) => typeof p === 'string');
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether `content` carries `block` as a whole block, not merely as text:
 * it starts a line there and ends where a block ends. A plain block ends at
 * a blank line or at the end; a part of a group (`part`) at a line end, since
 * the next part follows on the next line and a part is one label line and
 * one excerpt line. A substring test took a shortened copy for the longer
 * one: a note shown whole, then edited to drop its last sentence, was a
 * prefix of its earlier copy and was left out, so the model kept the old text.
 */
function holdsBlock(content: string, block: string, part: boolean): boolean {
  for (let at = content.indexOf(block); at >= 0; at = content.indexOf(block, at + 1)) {
    if (at > 0 && content[at - 1] !== '\n') continue;
    const after = content.slice(at + block.length);
    if (after === '' || after === '\n' || after.startsWith('\n\n') || (part && after.startsWith('\n'))) return true;
  }
  return false;
}

/**
 * `promptContext` without the `blocks` an earlier user message in `history`
 * already carries, plus `REPEATED_CONTEXT_NOTE` when any went.
 */
export function omitRepeatedContext(promptContext: string, blocks: readonly unknown[] | undefined, history: readonly AgentMessage[]): string {
  return withoutRepeatedContext(promptContext, blocks, history).text;
}

export interface WithoutRepeatedContext {
  text: string;
  /** Every block and part left out, trimmed: what a later restore checks. */
  omitted: string[];
  /** The groups some of whose parts went, with the parts that went. */
  fences: OmittedFence[];
  /**
   * The whole blocks that are no longer in `text`: plain blocks, and groups
   * every part of which went (the group as it stood, trimmed). For the prompt
   * composition, which knows each hook's block as one piece.
   */
  leftOut: string[];
  /** Where `REPEATED_CONTEXT_NOTE` starts in `text`; -1 when nothing was left out. */
  noteAt: number;
  /**
   * The groups some but not all of whose parts went: the group as it stood
   * and as it is sent (both trimmed), and how many of its parts went. For the
   * prompt composition, which would otherwise count the whole group as sent.
   */
  shortened: Array<{ from: string; to: string; omittedParts: number; parts: number }>;
}

/** `omitRepeatedContext`, also naming what it left out. */
export function withoutRepeatedContext(
  promptContext: string,
  blocks: readonly unknown[] | undefined,
  history: readonly AgentMessage[],
): WithoutRepeatedContext {
  const unchanged: WithoutRepeatedContext = { text: promptContext, omitted: [], fences: [], leftOut: [], noteAt: -1, shortened: [] };
  if (!promptContext || !blocks?.length) return unchanged;
  const earlier = userContents(history);
  if (!earlier.length) return unchanged;
  let out = promptContext;
  const omitted: string[] = [];
  const fences: OmittedFence[] = [];
  const leftOut: string[] = [];
  const shortened: WithoutRepeatedContext['shortened'] = [];
  const inView = (block: string, part: boolean) =>
    block.length >= MIN_BLOCK_CHARS && out.includes(block) && earlier.some((content) => holdsBlock(content, block, part));
  for (const raw of blocks) {
    if (typeof raw === 'string') {
      const block = raw.trim();
      if (!inView(block, false)) continue;
      out = out.replace(block, '');
      omitted.push(block);
      leftOut.push(block);
      continue;
    }
    if (!isGroup(raw)) continue;
    const whole = `${raw.head}${raw.parts.join('')}${raw.tail}`.trim();
    if (!out.includes(whole)) continue;
    const went: string[] = [];
    for (const part of raw.parts.map((p) => p.trim())) {
      if (!inView(part, true)) continue;
      out = out.replace(part, '');
      went.push(part);
    }
    if (!went.length) continue;
    omitted.push(...went);
    fences.push({ head: raw.head, tail: raw.tail, parts: went });
    if (went.length === raw.parts.length) {
      // Nothing left inside: the fence goes too.
      out = out.replace(new RegExp(`${escapeRegExp(raw.head.trim())}\\s*${escapeRegExp(raw.tail.trim())}`), '');
      leftOut.push(whole);
    } else {
      const sent = raw.parts.filter((p) => !went.includes(p.trim()));
      shortened.push({ from: whole, to: `${raw.head}${sent.join('')}${raw.tail}`.trim(), omittedParts: went.length, parts: raw.parts.length });
    }
  }
  if (!omitted.length) return unchanged;
  const rest = out.replace(/\n{3,}/g, '\n\n').trim();
  const text = rest ? `${rest}\n\n${REPEATED_CONTEXT_NOTE}` : REPEATED_CONTEXT_NOTE;
  return { text, omitted, fences, leftOut, noteAt: text.length - REPEATED_CONTEXT_NOTE.length, shortened };
}

/** This turn's user message as sent, and the blocks left out of it. */
export interface OmittedContext {
  content: string;
  omitted: string[];
  /** Which of `omitted` are parts of a fenced group, and the fence to put them back in. */
  fences?: OmittedFence[];
  /**
   * Where `REPEATED_CONTEXT_NOTE` starts in `content` (`noteAt` of
   * `withoutRepeatedContext` when the context opens the message). A passage
   * or the user's own text can hold the same sentence; the restore replaces
   * this one.
   */
  noteAt: number;
}

/**
 * After an in-turn compaction: put back into this turn's user message every
 * omitted block that no other user message in `history` carries any more. The
 * decision to omit was made against the history at the start of the turn; a
 * compaction that summarizes the earlier copy would otherwise leave the note
 * pointing at nothing until the next turn. The compaction has already
 * rewritten the prefix, so changing this message costs no cache.
 *
 * A part of a fenced group goes back inside its fence when the message still
 * has it (other parts were sent), or comes back fenced in place of the note.
 *
 * The message is found by its content (a compaction may copy messages), and
 * rewritten in place. Returns the state to keep for the next compaction, or
 * undefined once nothing is left out (or the message itself was compacted).
 */
export function restoreOmittedContext(history: AgentMessage[], turn: OmittedContext): OmittedContext | undefined {
  const message = history.find((m) => m.role === 'user' && m.content === turn.content);
  if (!message) return undefined;
  const others = userContents(history.filter((m) => m !== message));
  const isPart = (block: string) => Boolean(turn.fences?.some((f) => f.parts.includes(block)));
  const missing = turn.omitted.filter((block) => !others.some((content) => holdsBlock(content, block, isPart(block))));
  if (!missing.length) return turn;
  const still = turn.omitted.filter((block) => !missing.includes(block));
  if (turn.content.slice(turn.noteAt, turn.noteAt + REPEATED_CONTEXT_NOTE.length) !== REPEATED_CONTEXT_NOTE) {
    coreLogger.warn({ noteAt: turn.noteAt }, 'repeated context: the note is not where it was put — the left-out blocks are not restored');
    return undefined;
  }
  // Fences sit before the note; what follows it (the user's text) is not touched.
  let content = turn.content.slice(0, turn.noteAt);
  const afterNote = turn.content.slice(turn.noteAt + REPEATED_CONTEXT_NOTE.length);
  const loose = missing.filter((block) => !turn.fences?.some((f) => f.parts.includes(block)));
  const fences: OmittedFence[] = [];
  for (const fence of turn.fences ?? []) {
    const back = fence.parts.filter((p) => missing.includes(p));
    const kept = fence.parts.filter((p) => !missing.includes(p));
    if (kept.length) fences.push({ ...fence, parts: kept });
    if (!back.length) continue;
    const head = fence.head.trim();
    const tail = fence.tail.trim();
    const at = content.indexOf(head);
    const end = at >= 0 ? content.indexOf(tail, at + head.length) : -1;
    if (end >= 0) content = `${content.slice(0, end)}${back.join('\n')}\n${content.slice(end)}`;
    else loose.push(`${head}\n${back.join('\n')}\n${tail}`);
  }
  const replacement = [loose.join('\n\n'), still.length ? REPEATED_CONTEXT_NOTE : ''].filter(Boolean).join('\n\n');
  const before = replacement ? content : content.replace(/\n\n$/, '');
  content = `${before}${replacement}${afterNote}`;
  message.content = content;
  const noteAt = before.length + replacement.length - REPEATED_CONTEXT_NOTE.length;
  return still.length ? { content, omitted: still, ...(fences.length ? { fences } : {}), noteAt } : undefined;
}

function userContents(history: readonly AgentMessage[]): string[] {
  return history
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content as string);
}
