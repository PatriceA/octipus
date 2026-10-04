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
import { assertNoteAccess } from '@/db/repositories/note-repository';
import { SpaceError } from '@/security/space-access';
import { coreLogger } from '@/utils/logger';
import { StaleWriteError, sha256Hex } from './hub';
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
  return decisions.run(proposalId, async (): Promise<AcceptResult> => {
    const proposal = await pendingIn(space, proposalId);
    if (proposal.action === 'archive') {
      const archived = await notes.archive(space, proposal.noteId);
      const decided = await decideProposal(space.workspaceId, proposalId, archived ? 'accepted' : 'stale', space.userId);
      if (!decided) throw new SpaceError('invalid_input', 'This proposal was decided meanwhile');
      if (archived) return { status: 'accepted', proposal: decided, revisionId: null, merged: false };
      return { status: 'stale', proposal: decided, base: proposal.baseBody, current: '', proposed: proposal.body };
    }
    try {
      const write = await notes.writeSpaceBody(space, proposal.noteId, {
        base: { sha256: proposal.baseSha256, text: proposal.baseBody },
        next: proposal.body,
        ...(proposal.title ? { title: proposal.title } : {}),
        origin: { kind: 'proposal', userId: space.userId, onBehalfOfUserId: proposal.userId },
      });
      const decided = await decideProposal(space.workspaceId, proposalId, 'accepted', space.userId);
      if (!decided) throw new SpaceError('invalid_input', 'This proposal was decided meanwhile');
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
}

/** Reject a pending proposal as `scope.userId` (an editor or owner). */
export async function rejectProposal(scope: NoteScope, proposalId: string): Promise<NoteEditProposal> {
  const space = spaceScopeOf(scope);
  assertNoteAccess(space, 'write');
  return decisions.run(proposalId, async () => {
    await pendingIn(space, proposalId);
    const decided = await decideProposal(space.workspaceId, proposalId, 'rejected', space.userId);
    if (!decided) throw new SpaceError('invalid_input', 'This proposal was decided meanwhile');
    return decided;
  });
}
