/**
 * What a user's message carries about interactive answers (spec §5.6, §6;
 * views: docs/plans/inline-ui-views-spec.md §4): reports of what happened to
 * earlier blocks in the client, the block a suggestion was sent from, and the
 * answer a view's Button sent. Turned into model-facing lines after checking
 * that every id belongs to the session.
 *
 * Reports and provenance for another session's blocks are dropped with a
 * warning: they are side information. An answer is the message itself, so an
 * answer that fails a check refuses the send (`InlineUiActionRefused`) — the
 * client says why instead of the agent reading a message without its values.
 */
import { inlineUiRepository } from '@/db/repositories/inline-ui-repository';
import {
  inlineUiProvenanceLine,
  inlineUiReportLine,
  type InlineUiReport,
  isJsonObject,
  isJsonValue,
  type InlineUiViewState,
  type JsonObject,
  stripUnsafeChars,
  validateViewAction,
  validateViewData,
} from '@/shared/inline-ui';
import { coreLogger } from '@/utils/logger';

/** `chat.send` `inlineUi.action` (and `room.post` `inlineUi.action`), as the schema let it through. */
export interface InlineUiActionInput {
  blockId: string;
  name: string;
  componentId: string;
  context: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export interface InlineUiSendInput {
  reports?: InlineUiReport[];
  provenance?: { inlineUiId: string };
  action?: InlineUiActionInput;
}

/** What the user row stores about the answer (`metadata.inlineUiAction`): the bubble shows it. */
export interface InlineUiActionRecord {
  blockId: string;
  name: string;
  context: JsonObject;
}

/** An accepted answer: its record for the user row, and the block's new state. */
export interface InlineUiAcceptedAction {
  record: InlineUiActionRecord;
  state: InlineUiViewState;
}

export interface InlineUiTurnNotes {
  /** Model-facing lines, one per accepted report, the provenance, then the answer. */
  notes: string[];
  /** The block the message was sent from, when it belongs to the session. */
  provenanceId?: string;
  /** The view answer the message carries, checked against the stored view. */
  action?: InlineUiAcceptedAction;
}

/** A view answer that fails a check: the send is refused with this message. */
export class InlineUiActionRefused extends Error {
  override readonly name = 'InlineUiActionRefused';
}

/**
 * The model's line for an accepted answer: ids, the event name and the values, labelled as values.
 * One line whatever the values hold: JSON escapes newlines, quotes and control characters,
 * `stripUnsafeChars` drops bidi and zero-width ones, and the two line separators JSON leaves
 * raw (U+2028, U+2029) are written as their escapes.
 */
export function inlineUiActionLine(record: InlineUiActionRecord): string {
  const values = stripUnsafeChars(JSON.stringify(record.context)).replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
  return `(system note: the user answered interactive answer ${record.blockId} — event "${record.name}", values: ${values})`;
}

/**
 * What the input guard reads for a message that answers a view: the content,
 * then every string value of the answer's context on a line of its own. The
 * values reach the model's prompt (`inlineUiActionLine`), so they pass the
 * guard the content passes, read raw (the note line holds them JSON-encoded,
 * which a pattern would not see through). Bounded: a context deeper than the
 * validated depth is read to 8 levels.
 */
export function inlineUiGuardInput(content: string, context: Record<string, unknown> | undefined): string {
  if (!context) return content;
  const values: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (typeof value === 'string') values.push(value);
    else if (depth >= 8 || value === null || typeof value !== 'object') return;
    else for (const v of Array.isArray(value) ? value : Object.values(value)) walk(v, depth + 1);
  };
  walk(context, 0);
  return values.length ? [content, ...values].join('\n') : content;
}

/**
 * Check a view answer against the session's stored view (the block, the
 * component, the event, the context keys and sizes, the data). Throws
 * `InlineUiActionRefused` with what is wrong.
 */
export async function checkInlineUiAction(sessionId: string, action: InlineUiActionInput, now = new Date()): Promise<InlineUiAcceptedAction> {
  const block = await inlineUiRepository.getInSession(action.blockId.toLowerCase(), sessionId);
  if (!block) throw new InlineUiActionRefused(`there is no interactive answer ${action.blockId} in this conversation`);
  if (block.kind !== 'view' || !block.view) throw new InlineUiActionRefused(`interactive answer ${block.id} has no buttons that answer`);
  const problem = validateViewAction(block.view, { blockId: block.id, name: action.name, componentId: action.componentId, context: action.context as JsonObject });
  if (problem) throw new InlineUiActionRefused(problem);
  const data = answerData(action.data, block.view.data, { sessionId, blockId: block.id });
  return {
    record: { blockId: block.id, name: action.name, context: action.context as JsonObject },
    state: { data, action: { name: action.name, componentId: action.componentId, at: now.toISOString() } },
  };
}

/**
 * The data model to store with an answer (§4): the one sent, or the view's
 * own when none was sent or the sent one is over the limit (a selectable
 * Table's row copies can grow it past a limit the answer itself never
 * needed; the web leaves it out then). Only data that is not a JSON object
 * refuses the answer.
 */
function answerData(sent: Record<string, unknown> | undefined, own: JsonObject, where: { sessionId: string; blockId: string }): JsonObject {
  if (sent === undefined) return own;
  if (!isJsonObject(sent) || !isJsonValue(sent)) throw new InlineUiActionRefused('the answer data must be a JSON object');
  const oversize = validateViewData(sent);
  if (oversize) {
    coreLogger.debug({ ...where, reason: oversize }, 'Interactive answer data over the limit — the view\'s own data is stored');
    return own;
  }
  return sent;
}

/** Store an accepted answer on its block (the reload shows it as given). */
export async function recordInlineUiAction(sessionId: string, action: InlineUiAcceptedAction): Promise<void> {
  const stored = await inlineUiRepository.setState(action.record.blockId, sessionId, action.state);
  // Checked a moment ago: only a block deleted with its session in between misses.
  if (!stored) coreLogger.warn({ sessionId, blockId: action.record.blockId }, 'Interactive answer state not stored — the view is gone');
}

export async function resolveInlineUiTurnNotes(sessionId: string, input: InlineUiSendInput | undefined): Promise<InlineUiTurnNotes> {
  if (!input || (!input.reports?.length && !input.provenance && !input.action)) return { notes: [] };
  const action = input.action ? await checkInlineUiAction(sessionId, input.action) : undefined;
  const ids = [...new Set([...(input.reports ?? []).map((r) => r.id), ...(input.provenance ? [input.provenance.inlineUiId] : [])])];
  const known = new Set((await inlineUiRepository.getManyInSession(ids, sessionId)).map((b) => b.id));
  const dropped = ids.filter((id) => !known.has(id));
  if (dropped.length > 0) coreLogger.warn({ sessionId, dropped }, 'Interactive-answer report or provenance for a block not in this session — ignored');
  const notes = (input.reports ?? []).filter((r) => known.has(r.id)).map(inlineUiReportLine);
  const provenanceId = input.provenance && known.has(input.provenance.inlineUiId) ? input.provenance.inlineUiId : undefined;
  if (provenanceId) notes.push(inlineUiProvenanceLine(provenanceId));
  if (action) notes.push(inlineUiActionLine(action.record));
  return { notes, ...(provenanceId ? { provenanceId } : {}), ...(action ? { action } : {}) };
}
