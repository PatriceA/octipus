/**
 * What a user's message carries about interactive answers (spec §5.6, §6):
 * reports of what happened to earlier blocks in the client, and the block a
 * suggestion was sent from. Turned into model-facing lines built from ids and
 * enums only, after checking that every id belongs to the session.
 */
import { inlineUiRepository } from '@/db/repositories/inline-ui-repository';
import { inlineUiProvenanceLine, inlineUiReportLine, type InlineUiReport } from '@/shared/inline-ui';
import { coreLogger } from '@/utils/logger';

export interface InlineUiSendInput {
  reports?: InlineUiReport[];
  provenance?: { inlineUiId: string };
}

export interface InlineUiTurnNotes {
  /** Model-facing lines, one per accepted report and the provenance. */
  notes: string[];
  /** The block the message was sent from, when it belongs to the session. */
  provenanceId?: string;
}

export async function resolveInlineUiTurnNotes(sessionId: string, input: InlineUiSendInput | undefined): Promise<InlineUiTurnNotes> {
  if (!input || (!input.reports?.length && !input.provenance)) return { notes: [] };
  const ids = [...new Set([...(input.reports ?? []).map((r) => r.id), ...(input.provenance ? [input.provenance.inlineUiId] : [])])];
  const known = new Set((await inlineUiRepository.getManyInSession(ids, sessionId)).map((b) => b.id));
  const dropped = ids.filter((id) => !known.has(id));
  if (dropped.length > 0) coreLogger.warn({ sessionId, dropped }, 'Interactive-answer report or provenance for a block not in this session — ignored');
  const notes = (input.reports ?? []).filter((r) => known.has(r.id)).map(inlineUiReportLine);
  const provenanceId = input.provenance && known.has(input.provenance.inlineUiId) ? input.provenance.inlineUiId : undefined;
  if (provenanceId) notes.push(inlineUiProvenanceLine(provenanceId));
  return { notes, ...(provenanceId ? { provenanceId } : {}) };
}
