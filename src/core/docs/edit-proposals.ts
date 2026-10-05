/**
 * Edit proposals (docs/plans/coworking-spec.md §7.4): what the agent wants
 * to change in a space note, waiting for a member to accept or reject it.
 *
 * In `suggest` mode (`workspaces.agent_edit_mode`, the default) an agent's
 * note write in a space creates — or, for the same session, updates — a
 * pending `note_edit_proposals` row instead of changing the note. Accepting
 * applies it through the document hub when its base still merges with the
 * note (`NoteService.writeSpaceBody`, diff3); otherwise the proposal turns
 * `stale` and the caller gets the three texts (base, current, proposed) to
 * show side by side. Rejecting closes it.
 *
 * The notes tool proposes through `proposeAgentEdit`, `proposeAgentCapture`
 * and `proposeAgentArchive`: an agent creating a new note still creates it
 * (nothing of anyone's is overwritten); every change to an existing one is
 * a proposal. Members with the note open hear of each change to its
 * proposals (`doc.proposals`, through the listener the gateway wiring sets).
 */
import type { NoteScope } from '@/db/repositories/note-repository';
import {
  decideProposal,
  getProposal,
  listProposals,
  pendingProposalOf,
  upsertPendingProposal,
} from '@/db/repositories/live-documents';
import type { NoteEditProposal, NoteEditProposalAction, NoteEditProposalStatus } from '@/db/schema/live-documents';
import type { Note } from '@/db/schema/notes';
import { assertNoteAccess } from '@/db/repositories/note-repository';
import { SpaceError } from '@/security/space-access';
import { coreLogger } from '@/utils/logger';
import { StaleWriteError, sha256Hex } from './hub';
import { normalizeNewlines } from './text-merge';
import { KeyedMutex } from './keyed-mutex';

type SpaceScope = NoteScope & { kind: 'space' };

const logger = coreLogger.child({ component: 'edit-proposals' });

function spaceScopeOf(scope: NoteScope): SpaceScope {
  if (scope.kind !== 'space') throw new SpaceError('not_found', 'Edit proposals exist in shared spaces only');
  return scope;
}

export interface ProposeInput {
  noteId: string;
  /** The agent session; one pending proposal per note and session. */
  sessionId: string | null;
  agentId: string | null;
  action: NoteEditProposalAction;
  title?: string | null;
  /** The text the agent read, and its sha. */
  baseBody: string;
  baseSha256: string;
  /** The text it proposes. */
  body: string;
}

/**
 * Create or update the session's pending proposal for a note of the space.
 * `scope.userId` is the member the agent works for; they must be able to
 * run the agent with write tools.
 */
export async function proposeNoteEdit(scope: NoteScope, input: ProposeInput): Promise<NoteEditProposal> {
  const space = spaceScopeOf(scope);
  assertNoteAccess(space, 'run_agent_write');
  if (sha256Hex(input.baseBody) !== input.baseSha256) throw new Error('proposeNoteEdit: baseSha256 is not the sha of baseBody');
  const { getNoteService } = await import('@/core/knowledge/notes');
  if (!(await getNoteService().store(space).getById(input.noteId))) throw new SpaceError('not_found', 'Note not found');
  const proposal = await upsertPendingProposal({
    noteId: input.noteId,
    workspaceId: space.workspaceId,
    userId: space.userId,
    sessionId: input.sessionId,
    agentId: input.agentId,
    action: input.action,
    title: input.title ?? null,
    baseBody: input.baseBody,
    baseSha256: input.baseSha256,
    body: input.body,
  });
  await proposalsChanged(space.workspaceId, input.noteId);
  return proposal;
}

/** The space's proposals, newest first (a note's, a status's). */
export async function listNoteProposals(scope: NoteScope, opts: { noteId?: string; status?: NoteEditProposalStatus } = {}): Promise<NoteEditProposal[]> {
  const space = spaceScopeOf(scope);
  assertNoteAccess(space, 'read');
  const proposals = await listProposals(space.workspaceId, opts);
  if (!space.folders) return proposals;
  // A guest (S6): the proposals of the notes their folders hold.
  const { getNoteService } = await import('@/core/knowledge/notes');
  const visible = new Set((await getNoteService().store(space).getByIds([...new Set(proposals.map((p) => p.noteId))])).map((n) => n.id));
  return proposals.filter((p) => visible.has(p.noteId));
}

/** The session's pending proposal for the note (`read_note` shows it to the agent). */
export function sessionPendingProposal(scope: NoteScope, noteId: string, sessionId: string): Promise<NoteEditProposal | null> {
  const space = spaceScopeOf(scope);
  return pendingProposalOf(space.workspaceId, noteId, sessionId);
}

export type AcceptResult =
  | { status: 'accepted'; proposal: NoteEditProposal; revisionId: string | null; merged: boolean }
  | {
    status: 'stale';
    proposal: NoteEditProposal;
    /** The three-way view: what the agent read, what the note says now, what it proposed. */
    base: string;
    current: string;
    proposed: string;
  };

const decisions = new KeyedMutex();

async function pendingIn(space: SpaceScope, proposalId: string): Promise<NoteEditProposal> {
  const proposal = await getProposal(space.workspaceId, proposalId);
  if (!proposal) throw new SpaceError('not_found', 'Proposal not found');
  if (proposal.status !== 'pending') throw new SpaceError('invalid_input', `This proposal is already ${proposal.status}`);
  return proposal;
}

/**
 * Accept a pending proposal as `scope.userId` (an editor or owner): apply it
 * through the hub when its base still merges with the note, else mark it
 * `stale` and return the three-way view.
 */
export async function acceptProposal(scope: NoteScope, proposalId: string): Promise<AcceptResult> {
  const space = spaceScopeOf(scope);
  assertNoteAccess(space, 'write');
  const { getNoteService } = await import('@/core/knowledge/notes');
  const notes = getNoteService();
  const result = await decisions.run(proposalId, async (): Promise<AcceptResult> => {
    const proposal = await pendingIn(space, proposalId);
    if (proposal.action === 'archive') {
      const archived = await notes.archive(space, proposal.noteId);
      const decided = await decideProposal(space.workspaceId, proposalId, archived ? 'accepted' : 'stale', space.userId);
      if (!decided) throw new SpaceError('invalid_input', 'This proposal was decided meanwhile');
      if (archived) return { status: 'accepted', proposal: decided, revisionId: null, merged: false };
      return { status: 'stale', proposal: decided, base: proposal.baseBody, current: '', proposed: proposal.body };
    }
    const { getDocHub } = await import('./index');
    // A closed note's links, tags and index are refreshed here (an open
    // one's by the hub, on last leave): what it said before is the base of
    // its body-derived tags.
    const before = getDocHub().isOpen(proposal.noteId) ? null : await notes.getById(space, proposal.noteId);
    try {
      const write = await notes.writeSpaceBody(space, proposal.noteId, {
        base: { sha256: proposal.baseSha256, text: proposal.baseBody },
        next: proposal.body,
        ...(proposal.title ? { title: proposal.title } : {}),
        origin: { kind: 'proposal', userId: space.userId, onBehalfOfUserId: proposal.userId },
      });
      const decided = await decideProposal(space.workspaceId, proposalId, 'accepted', space.userId);
      if (!decided) throw new SpaceError('invalid_input', 'This proposal was decided meanwhile');
      if (before && write.changed && !getDocHub().isOpen(proposal.noteId)) {
        // The change is saved and the proposal accepted: a failed refresh
        // leaves the note's links and index behind its text until its next
        // write, and is logged as such.
        await notes.refreshSpaceNote(proposal.noteId, space.userId, before.body).catch((err: unknown) => {
          logger.error({ err, proposalId, noteId: proposal.noteId }, 'Accepted edit proposal saved, but refreshing the note links and index failed');
        });
      }
      return { status: 'accepted', proposal: decided, revisionId: write.revisionId, merged: write.merged };
    } catch (err) {
      if (!(err instanceof StaleWriteError)) throw err;
      const current = await notes.getById(space, proposal.noteId);
      const decided = await decideProposal(space.workspaceId, proposalId, 'stale', space.userId);
      if (!decided) throw new SpaceError('invalid_input', 'This proposal was decided meanwhile');
      logger.info({ proposalId, noteId: proposal.noteId, reason: err.reason }, 'Edit proposal is stale');
      return { status: 'stale', proposal: decided, base: proposal.baseBody, current: current?.body ?? '', proposed: proposal.body };
    }
  });
  await proposalsChanged(space.workspaceId, result.proposal.noteId);
  return result;
}

/** Reject a pending proposal as `scope.userId` (an editor or owner). */
export async function rejectProposal(scope: NoteScope, proposalId: string): Promise<NoteEditProposal> {
  const space = spaceScopeOf(scope);
  assertNoteAccess(space, 'write');
  const decided = await decisions.run(proposalId, async () => {
    await pendingIn(space, proposalId);
    const row = await decideProposal(space.workspaceId, proposalId, 'rejected', space.userId);
    if (!row) throw new SpaceError('invalid_input', 'This proposal was decided meanwhile');
    return row;
  });
  await proposalsChanged(space.workspaceId, decided.noteId);
  return decided;
}

// ── The agent's note writes in suggest mode ────────────────────────

/** Who proposes: the agent and its session (one pending proposal per note and session). */
export interface AgentProposer {
  sessionId: string;
  agentId: string | null;
}

/**
 * The note as the agent's base names it: its current (live) text when the
 * sha matches, else a base the hub handed out, else the base of the
 * session's own pending proposal. Throws `StaleWriteError('unknown_base')`
 * when none is that text — the agent reads the note again.
 */
async function baseTextOf(space: SpaceScope, noteId: string, sessionId: string, sha256: string): Promise<{ text: string; note: Note }> {
  const { getNoteService } = await import('@/core/knowledge/notes');
  const note = await getNoteService().getById(space, noteId);
  if (!note) throw new SpaceError('not_found', 'Note not found');
  if (note.bodySha256 === sha256) return { text: note.body, note };
  const { getDocHub } = await import('./index');
  const pinned = getDocHub().baseText(noteId, sha256);
  if (pinned !== null) return { text: pinned, note };
  const pending = await pendingProposalOf(space.workspaceId, noteId, sessionId);
  if (pending?.baseSha256 === sha256) return { text: pending.baseBody, note };
  throw new StaleWriteError('unknown_base', note.bodySha256);
}

/**
 * `write_note` on an existing space note in suggest mode: the agent's body
 * (and title, when it changes it) becomes the session's pending proposal,
 * made from the text whose sha it read.
 */
export async function proposeAgentEdit(
  scope: NoteScope,
  proposer: AgentProposer,
  input: { noteId: string; baseSha256: string; body: string; title?: string },
): Promise<NoteEditProposal> {
  const space = spaceScopeOf(scope);
  assertNoteAccess(space, 'run_agent_write');
  const { assertSpaceNoteSize } = await import('@/core/knowledge/notes');
  const body = normalizeNewlines(input.body);
  assertSpaceNoteSize(body);
  const base = await baseTextOf(space, input.noteId, proposer.sessionId, input.baseSha256);
  return proposeNoteEdit(space, {
    noteId: input.noteId,
    sessionId: proposer.sessionId,
    agentId: proposer.agentId,
    action: 'edit',
    title: input.title !== undefined && input.title !== base.note.title ? input.title : null,
    baseBody: base.text,
    baseSha256: input.baseSha256,
    body,
  });
}

/**
 * `capture_note` in a space in suggest mode. The day's note does not
 * exist yet: it is created with the line (a new note, nobody's text
 * changes). Otherwise the line is appended to the session's pending
 * proposal for it, or to the note's current text as a new proposal.
 */
export async function proposeAgentCapture(
  scope: NoteScope,
  proposer: AgentProposer,
  text: string,
  day?: string,
): Promise<{ proposal: NoteEditProposal; note?: undefined } | { proposal?: undefined; note: Note }> {
  const space = spaceScopeOf(scope);
  assertNoteAccess(space, 'run_agent_write');
  const { assertSpaceNoteSize, getNoteService, normalizeDay } = await import('@/core/knowledge/notes');
  const notes = getNoteService();
  const date = normalizeDay(day ?? new Date().toISOString());
  const daily = await notes.getBySlug(space, `daily/${date}`);
  if (!daily) return { note: await notes.capture(space, text, date) };
  const line = `- ${new Date().toISOString().slice(11, 16)} ${normalizeNewlines(text)}\n`;
  const append = (body: string) => `${body.replace(/\s+$/, '')}\n${line}`;
  const pending = await pendingProposalOf(space.workspaceId, daily.id, proposer.sessionId);
  const from = pending && pending.action !== 'archive'
    ? { baseBody: pending.baseBody, baseSha256: pending.baseSha256, body: append(pending.body), action: pending.action, title: pending.title }
    : { baseBody: daily.body, baseSha256: daily.bodySha256, body: append(daily.body), action: 'capture' as const, title: null };
  assertSpaceNoteSize(from.body);
  return {
    proposal: await proposeNoteEdit(space, { noteId: daily.id, sessionId: proposer.sessionId, agentId: proposer.agentId, ...from }),
  };
}

/** `archive_note` in a space in suggest mode: archiving becomes the session's pending proposal for the note. */
export async function proposeAgentArchive(scope: NoteScope, proposer: AgentProposer, noteId: string): Promise<NoteEditProposal> {
  const space = spaceScopeOf(scope);
  assertNoteAccess(space, 'run_agent_write');
  const { getNoteService } = await import('@/core/knowledge/notes');
  const note = await getNoteService().getById(space, noteId);
  if (!note) throw new SpaceError('not_found', 'Note not found');
  return proposeNoteEdit(space, {
    noteId,
    sessionId: proposer.sessionId,
    agentId: proposer.agentId,
    action: 'archive',
    baseBody: note.body,
    baseSha256: note.bodySha256,
    body: note.body,
  });
}

// ── Change notification ─────────────────────────────────────────

let listener: (workspaceId: string, noteId: string, pending: number) => void = () => undefined;

/** Set who hears that a note's proposals changed (the gateway wiring publishes `doc.proposals` to the note's editors). */
export function setProposalChangeListener(fn: (workspaceId: string, noteId: string, pending: number) => void): void {
  listener = fn;
}

/** Tell the listener how many proposals of the note are pending now. Never throws: the change itself was saved. */
async function proposalsChanged(workspaceId: string, noteId: string): Promise<void> {
  try {
    const pending = (await listProposals(workspaceId, { noteId, status: 'pending' })).length;
    listener(workspaceId, noteId, pending);
  } catch (err) {
    logger.error({ err, workspaceId, noteId }, 'Publishing an edit proposal change failed');
  }
}
