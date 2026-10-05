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
import { ToolNotExecutedError } from '@/core/tool-execution-error';
import { coreLogger } from '@/utils/logger';
import { StaleWriteError, sha256Hex } from './hub';
import { KeyedMutex } from './keyed-mutex';
import { merge3, normalizeNewlines } from './text-merge';

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
 * One read-modify-write of a (note, session) proposal at a time: the
 * agent's updates (swarm children and parallel workers share the root's
 * session), and a member's accept or reject of it (single process, D16).
 */
const proposalLocks = new KeyedMutex();
const proposalKey = (noteId: string, sessionId: string | null, proposalId?: string) => `${noteId}:${sessionId ?? proposalId ?? 'none'}`;

/**
 * Create or update the session's pending proposal for a note of the space.
 * `scope.userId` is the member the agent works for; they must be able to
 * run the agent with write tools.
 */
export async function proposeNoteEdit(scope: NoteScope, input: ProposeInput): Promise<NoteEditProposal> {
  const space = spaceScopeOf(scope);
  assertNoteAccess(space, 'run_agent_write');
  const proposal = await proposalLocks.run(proposalKey(input.noteId, input.sessionId), () => writeProposal(space, input));
  await proposalsChanged(space.workspaceId, input.noteId);
  return proposal;
}

/** `proposeNoteEdit`'s write, under the caller's proposal lock. */
async function writeProposal(space: SpaceScope, input: ProposeInput): Promise<NoteEditProposal> {
  if (sha256Hex(input.baseBody) !== input.baseSha256) throw new Error('proposeNoteEdit: baseSha256 is not the sha of baseBody');
  const { getNoteService } = await import('@/core/knowledge/notes');
  if (!(await getNoteService().store(space).getById(input.noteId))) throw new SpaceError('not_found', 'Note not found');
  return upsertPendingProposal({
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
}

/** The space's proposals, newest first (a note's, a status's). */
export function listNoteProposals(scope: NoteScope, opts: { noteId?: string; status?: NoteEditProposalStatus } = {}): Promise<NoteEditProposal[]> {
  const space = spaceScopeOf(scope);
  assertNoteAccess(space, 'read');
  return listProposals(space.workspaceId, opts);
}

/** The session's pending proposal for the note. */
export function sessionPendingProposal(scope: NoteScope, noteId: string, sessionId: string): Promise<NoteEditProposal | null> {
  const space = spaceScopeOf(scope);
  return pendingProposalOf(space.workspaceId, noteId, sessionId);
}

/**
 * A pending proposal as the agent sees it beside the note's current text
 * (`read_note`): rebased onto that text, so the agent edits from it and
 * names the current sha as its base; or `stale` when its change collides
 * with what members wrote since (it can only be replaced: written again
 * from the current text).
 */
export interface RebasedProposal {
  stale: boolean;
  body: string;
  /** The base to name when writing from `body` (stale: the proposal's own, outdated base). */
  baseSha256: string;
}

export function rebaseOnto(proposal: NoteEditProposal, current: { body: string; bodySha256: string }): RebasedProposal {
  if (proposal.action === 'archive' || proposal.baseSha256 === current.bodySha256) {
    return { stale: false, body: proposal.action === 'archive' ? current.body : proposal.body, baseSha256: current.bodySha256 };
  }
  const merged = merge3(proposal.baseBody, current.body, proposal.body);
  if (!merged.ok) return { stale: true, body: proposal.body, baseSha256: proposal.baseSha256 };
  return { stale: false, body: merged.text, baseSha256: current.bodySha256 };
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

async function pendingIn(space: SpaceScope, proposalId: string): Promise<NoteEditProposal> {
  const proposal = await getProposal(space.workspaceId, proposalId);
  if (!proposal) throw new SpaceError('not_found', 'Proposal not found');
  if (proposal.status !== 'pending') throw new SpaceError('invalid_input', `This proposal is already ${proposal.status}`);
  return proposal;
}

/**
 * Run a decision on a pending proposal under its (note, session) lock, so
 * the agent cannot update it between the read and the decision; `fn` gets
 * the proposal as read under the lock.
 */
async function deciding<T>(space: SpaceScope, proposalId: string, fn: (proposal: NoteEditProposal) => Promise<T>): Promise<T> {
  const first = await pendingIn(space, proposalId);
  return proposalLocks.run(proposalKey(first.noteId, first.sessionId, first.id), async () => fn(await pendingIn(space, proposalId)));
}

/**
 * Mark `proposal` (as it was read) decided. Conditional on its content: a
 * proposal the agent updated after it was read is not marked as decided
 * with a body nobody reviewed.
 */
async function decide(space: SpaceScope, proposal: NoteEditProposal, status: 'accepted' | 'rejected' | 'stale'): Promise<NoteEditProposal> {
  const decided = await decideProposal(space.workspaceId, proposal.id, status, space.userId, proposal);
  if (decided) return decided;
  const now = await getProposal(space.workspaceId, proposal.id);
  if (now?.status === 'pending') throw new SpaceError('invalid_input', 'The agent updated this proposal meanwhile; review it again');
  throw new SpaceError('invalid_input', 'This proposal was decided meanwhile');
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
  const result = await deciding(space, proposalId, async (proposal): Promise<AcceptResult> => {
    if (proposal.action === 'archive') {
      // Archived only while the note still says what the agent read: a note
      // edited since is not archived over that edit.
      const archived = await notes.archive(space, proposal.noteId, { baseSha256: proposal.baseSha256 });
      const decided = await decide(space, proposal, archived ? 'accepted' : 'stale');
      if (archived) return { status: 'accepted', proposal: decided, revisionId: null, merged: false };
      const current = await notes.getById(space, proposal.noteId);
      return { status: 'stale', proposal: decided, base: proposal.baseBody, current: current?.body ?? '', proposed: proposal.body };
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
      const decided = await decide(space, proposal, 'accepted');
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
      const decided = await decide(space, proposal, 'stale');
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
  const decided = await deciding(space, proposalId, (proposal) => decide(space, proposal, 'rejected'));
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
async function baseTextOf(note: Note, pending: NoteEditProposal | null, sha256: string): Promise<string> {
  if (note.bodySha256 === sha256) return note.body;
  const { getDocHub } = await import('./index');
  const pinned = getDocHub().baseText(note.id, sha256);
  if (pinned !== null) return pinned;
  if (pending?.baseSha256 === sha256) return pending.baseBody;
  throw new StaleWriteError('unknown_base', note.bodySha256);
}

/**
 * One pending proposal per (note, session) holds one action: an archive
 * does not silently replace an edit, nor an edit an archive. The agent is
 * told what is pending; a member accepts or rejects it first.
 */
function assertSameKind(pending: NoteEditProposal | null, action: 'archive' | 'change'): void {
  if (!pending) return;
  if (action === 'archive' && pending.action !== 'archive') {
    throw new ToolNotExecutedError('notes', 'Nothing was proposed: you have a pending edit proposal for this note, which archiving would replace. A member accepts or rejects it first (read_note shows it).');
  }
  if (action === 'change' && pending.action === 'archive') {
    throw new ToolNotExecutedError('notes', 'Nothing was proposed: you have a pending proposal to archive this note, which an edit would replace. A member accepts or rejects it first.');
  }
}

async function liveNote(space: SpaceScope, noteId: string): Promise<Note> {
  const { getNoteService } = await import('@/core/knowledge/notes');
  const note = await getNoteService().getById(space, noteId);
  if (!note) throw new SpaceError('not_found', 'Note not found');
  return note;
}

/** What an agent's write proposed: the proposal, or nothing (the write changed nothing; `pending` is the session's proposal, left as it is). */
export type AgentProposal =
  | { proposal: NoteEditProposal; unchanged?: undefined }
  | { proposal?: undefined; unchanged: true; pending: NoteEditProposal | null };

/**
 * `write_note` on an existing space note in suggest mode: the agent's body
 * (and title, when it changes it) becomes the session's pending proposal,
 * made from the text whose sha it read.
 *
 * The pending proposal is rebased: `read_note` shows it merged onto the
 * note's current text, with the current sha as the base to name. A write
 * naming a base other than the proposal's carries the proposal forward —
 * merge3(the proposal's base, the text the agent read, its body) — so the
 * accepted proposal never reverts what members wrote between the two
 * reads; a collision refuses the write. A write that changes nothing
 * proposes nothing.
 */
export async function proposeAgentEdit(
  scope: NoteScope,
  proposer: AgentProposer,
  input: { noteId: string; baseSha256: string; body: string; title?: string },
): Promise<AgentProposal> {
  const space = spaceScopeOf(scope);
  assertNoteAccess(space, 'run_agent_write');
  const { assertSpaceNoteSize } = await import('@/core/knowledge/notes');
  let body = normalizeNewlines(input.body);
  assertSpaceNoteSize(body);
  const result = await proposalLocks.run(proposalKey(input.noteId, proposer.sessionId), async (): Promise<AgentProposal> => {
    const note = await liveNote(space, input.noteId);
    const pending = await pendingProposalOf(space.workspaceId, input.noteId, proposer.sessionId);
    assertSameKind(pending, 'change');
    const baseText = await baseTextOf(note, pending, input.baseSha256);
    if (pending && (pending.agentId ?? null) !== proposer.agentId) {
      // Another agent of the session (a swarm child, a parallel worker)
      // made the pending proposal: both changes are kept, or the write is
      // refused — never one silently replacing the other.
      const theirs = pending.baseSha256 === input.baseSha256 ? { ok: true as const, text: pending.body } : merge3(pending.baseBody, baseText, pending.body);
      const merged = theirs.ok ? merge3(baseText, theirs.text, body) : theirs;
      if (!merged.ok) {
        throw new ToolNotExecutedError('notes', 'Nothing was proposed: another agent of this session has a pending proposal for this note that changes the same text. '
          + 'read_note shows it; write your change from that proposal body with the base_sha256 beside it.');
      }
      body = merged.text;
      assertSpaceNoteSize(body);
    } else if (pending && pending.baseSha256 !== input.baseSha256) {
      const merged = merge3(pending.baseBody, baseText, body);
      if (!merged.ok) {
        throw new ToolNotExecutedError('notes', 'Nothing was proposed: your pending proposal collides with what members wrote since. '
          + 'read_note, then write your change again from the note\'s current body with its sha256 as base_sha256; that replaces the proposal.');
      }
      body = merged.text;
      assertSpaceNoteSize(body);
    }
    const newTitle = input.title !== undefined && input.title !== note.title ? input.title : null;
    // Another agent's proposed title is kept unless this write names one.
    const title = newTitle ?? (pending && (pending.agentId ?? null) !== proposer.agentId ? pending.title : null);
    if (body === baseText && title === null) return { unchanged: true, pending };
    if (pending && body === pending.body && title === pending.title && input.baseSha256 === pending.baseSha256) return { unchanged: true, pending };
    return {
      proposal: await writeProposal(space, {
        noteId: input.noteId,
        sessionId: proposer.sessionId,
        agentId: proposer.agentId,
        action: pending?.action === 'capture' ? 'capture' : 'edit',
        title,
        baseBody: baseText,
        baseSha256: input.baseSha256,
        body,
      }),
    };
  });
  if (result.proposal) await proposalsChanged(space.workspaceId, input.noteId);
  return result;
}

/**
 * `capture_note` in a space in suggest mode. The day's note does not
 * exist yet: it is created with the line (a new note, nobody's text
 * changes; created only while still missing, else the line is proposed).
 * Otherwise the line is appended to the session's pending proposal for it,
 * or to the note's current text as a new proposal.
 */
export async function proposeAgentCapture(
  scope: NoteScope,
  proposer: AgentProposer,
  text: string,
  day?: string,
): Promise<{ proposal: NoteEditProposal; note?: undefined } | { proposal?: undefined; note: Note }> {
  const space = spaceScopeOf(scope);
  assertNoteAccess(space, 'run_agent_write');
  const { assertSpaceNoteSize, getNoteService, normalizeDay, NoteExistsError } = await import('@/core/knowledge/notes');
  const notes = getNoteService();
  const date = normalizeDay(day ?? new Date().toISOString());
  let daily = await notes.getBySlug(space, `daily/${date}`);
  if (!daily) {
    try {
      return { note: await notes.capture(space, text, date, { createOnly: true }) };
    } catch (err) {
      // A member started the day's note meanwhile: the line is proposed.
      if (!(err instanceof NoteExistsError)) throw err;
      daily = await liveNote(space, err.noteId);
    }
  }
  const noteId = daily.id;
  const line = `- ${new Date().toISOString().slice(11, 16)} ${normalizeNewlines(text)}\n`;
  const append = (body: string) => `${body.replace(/\s+$/, '')}\n${line}`;
  const proposal = await proposalLocks.run(proposalKey(noteId, proposer.sessionId), async () => {
    // Read under the lock: two captures of one session each add their line.
    const current = await liveNote(space, noteId);
    const pending = await pendingProposalOf(space.workspaceId, noteId, proposer.sessionId);
    assertSameKind(pending, 'change');
    const from = pending
      ? { baseBody: pending.baseBody, baseSha256: pending.baseSha256, body: append(pending.body), action: pending.action, title: pending.title }
      : { baseBody: current.body, baseSha256: current.bodySha256, body: append(current.body), action: 'capture' as const, title: null };
    assertSpaceNoteSize(from.body);
    return writeProposal(space, { noteId, sessionId: proposer.sessionId, agentId: proposer.agentId, ...from });
  });
  await proposalsChanged(space.workspaceId, noteId);
  return { proposal };
}

/** `archive_note` in a space in suggest mode: archiving becomes the session's pending proposal for the note. */
export async function proposeAgentArchive(scope: NoteScope, proposer: AgentProposer, noteId: string): Promise<NoteEditProposal> {
  const space = spaceScopeOf(scope);
  assertNoteAccess(space, 'run_agent_write');
  const proposal = await proposalLocks.run(proposalKey(noteId, proposer.sessionId), async () => {
    const note = await liveNote(space, noteId);
    assertSameKind(await pendingProposalOf(space.workspaceId, noteId, proposer.sessionId), 'archive');
    return writeProposal(space, {
      noteId,
      sessionId: proposer.sessionId,
      agentId: proposer.agentId,
      action: 'archive',
      baseBody: note.body,
      baseSha256: note.bodySha256,
      body: note.body,
    });
  });
  await proposalsChanged(space.workspaceId, noteId);
  return proposal;
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
