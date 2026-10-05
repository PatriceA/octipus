/**
 * The per-turn context of a space session (docs/plans/coworking-spec.md
 * §6.5, §6.7): the space memory and, in a room's private side panel, the
 * linked room's recent transcript.
 *
 * Both are read afresh at every turn — a retracted memory entry stops at
 * once, a member removed from the linked room gets no transcript — so no
 * copy of them may outlive its turn. They ride in the turn's volatile
 * prompt tier, which the workers store with the user row as
 * `metadata.promptContext` and keep in the native conversation snapshot;
 * the block is therefore wrapped in markers with a random tag, and
 * `omitSpaceTurnContext` cuts it out wherever a turn's context is stored or
 * replayed.
 */
import { randomBytes } from 'node:crypto';

const OPEN = '--- SPACE TURN CONTEXT';
const CLOSE = '--- END SPACE TURN CONTEXT';

/** One wrapped block, with the blank lines before it. */
const BLOCK = /(?:\n\n)?--- SPACE TURN CONTEXT ([0-9a-f]{12}) \(this turn only\) ---[\s\S]*?--- END SPACE TURN CONTEXT \1 ---/g;

/** Wrap `block` (already self-separating, starting with blank lines) for one turn; empty stays empty. */
export function fenceSpaceTurnContext(block: string): string {
  if (!block) return '';
  let tag: string;
  do tag = randomBytes(6).toString('hex');
  while (block.includes(tag));
  return `\n\n${OPEN} ${tag} (this turn only) ---${block}\n${CLOSE} ${tag} ---`;
}

/** `text` without its space turn context blocks — for storing or replaying a turn. */
export function omitSpaceTurnContext(text: string): string {
  return text.replace(BLOCK, '');
}
