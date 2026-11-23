import type { EmbeddingPurpose } from '@/core/rag/embeddings';

/**
 * The embedding purposes a note's chunks are stored under
 * (docs/plans/learning-notes-and-skill-discovery.md, "A lesson note"): a
 * lesson note, written by a learning review, under `'lesson'`; every other
 * note under `'note'`. A reader that means "any note" filters on both.
 */
export const NOTE_PURPOSES = ['note', 'lesson'] as const satisfies readonly EmbeddingPurpose[];
export type NotePurpose = (typeof NOTE_PURPOSES)[number];

/** The embedding purpose of a note of this kind. */
export function notePurposeFor(noteKind: string): NotePurpose {
  return noteKind === 'lesson' ? 'lesson' : 'note';
}
