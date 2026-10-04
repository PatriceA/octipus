import { describe, expect, test } from 'vitest';
import type { EmbeddingService } from '@/core/rag/embeddings';
import type { KnowledgeLinkRepository } from '@/db/repositories/knowledge-link-repository';
import { type NoteRepository, personalNoteScope } from '@/db/repositories/note-repository';
import { SuggestionService } from './suggestions';

/**
 * Link suggestions stay inside the note's workspace: a similar note of the
 * user's other workspace is never offered, whatever its embedding says.
 */
const USER = 'aaaaaaaa-0000-4000-8000-000000000001';
const WS = 'bbbbbbbb-0000-4000-8000-000000000001';
const SELF = '00000000-0000-4000-8000-000000000001';
const SAME_WS = '00000000-0000-4000-8000-000000000002';
const USER_LEVEL = '00000000-0000-4000-8000-000000000003';
const OTHER_WS = '00000000-0000-4000-8000-000000000004';

// Notes as the repository stores them: which workspace each belongs to.
const rows: Record<string, string | null> = { [SELF]: WS, [SAME_WS]: WS, [USER_LEVEL]: null, [OTHER_WS]: 'cccccccc-0000-4000-8000-000000000001' };
const readable = (id: string, ws?: string) => id in rows && (ws === undefined || rows[id] === ws || rows[id] === null);

function service(seen: { scope?: unknown; outgoingWs?: string }) {
  const notes = {
    getById: async (_u: string, id: string, ws?: string) => (readable(id, ws) ? { id, title: 't', body: 'b' } : null),
    getByIds: async (_u: string, ids: string[], ws?: string) => ids.filter((id) => readable(id, ws)).map((id) => ({ id })),
  } as unknown as NoteRepository;
  const links = {
    getOutgoing: async (_u: string, _t: string, _id: string, ws?: string) => { seen.outgoingWs = ws; return []; },
  } as unknown as KnowledgeLinkRepository;
  const embeddings = {
    hybridSearch: async (scope: unknown) => {
      seen.scope = scope;
      return [SELF, OTHER_WS, SAME_WS, USER_LEVEL].map((id, i) => ({ sourceId: `note:${id}`, similarity: 0.9 - i / 10, metadata: { title: id } }));
    },
  } as unknown as EmbeddingService;
  return new SuggestionService(notes, links, embeddings);
}

describe('SuggestionService.suggestForNote', () => {
  test("offers the workspace's and user-level notes, never another workspace's", async () => {
    const seen: { scope?: unknown; outgoingWs?: string } = {};
    const out = await service(seen).suggestForNote(personalNoteScope(USER, WS), SELF);
    expect(out.map((s) => s.id)).toEqual([SAME_WS, USER_LEVEL]);
    expect(seen.scope).toEqual({ kind: 'personal', userId: USER, workspaceId: WS });
    expect(seen.outgoingWs).toBe(WS);
  });

  test("a note of another workspace is not found from this one", async () => {
    await expect(service({}).suggestForNote(personalNoteScope(USER, WS), OTHER_WS)).rejects.toThrow(/not found/);
  });
});
