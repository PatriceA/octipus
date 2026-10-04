/**
 * `contentRepos(principal)` — the one entry point to content
 * (docs/plans/coworking-spec.md §5.5).
 *
 * A personal principal gets its personal repositories (`scopedRepos` plus
 * the personal note, link, artifact, knowledge and file scopes); a principal
 * the resolver marked shared gets `spaceRepos` — the same method surface, so
 * a route or a tool written against `ContentRepos` reads and writes space
 * rows by the member's role without knowing which door it went through.
 * Writes refused by the role throw `SpaceError` (403 / 404 / 409 through the
 * API's error handler).
 */
import type { KnowledgeOwner, KnowledgeScope } from '@/core/rag/knowledge-scope';
import type { AgentContext } from '@/core/types';
import { agentPrincipal, type Principal } from '@/security/principal';
import type { SpaceAction, SpaceRole } from '@/security/space-access';
import { WorkspaceFS } from '@/security/workspace-fs';
import { type NoteScope, type NoteStore, PersonalNoteRepo } from './note-repository';
import {
  type ScopedAgentRepo,
  type ScopedDocumentRepo,
  type ScopedMessageRepo,
  type ScopedNotificationRepo,
  type ScopedPipelineRepo,
  type ScopedSessionRepo,
  scopedRepos,
  type TaskRepo,
  assertPersonalWorkspace,
} from './scoped';
import { ArtifactStore, type LinkStore, linkStoreFor, spaceRepos } from './space';

export interface ContentRepos {
  readonly kind: 'personal' | 'space';
  readonly principal: Principal;
  /** The workspace content is read from and written to (null: a personal principal without one). */
  readonly workspaceId: string | null;
  /** The member's role in a space; null in personal scope. */
  readonly role: SpaceRole | null;
  /** Throws `SpaceError` unless `action` is allowed here (always allowed in personal scope). */
  can(action: SpaceAction): void;
  /** Throws `SpaceError('archived')` when the space reads only; never in personal scope. */
  assertOpen(): void;
  sessions: ScopedSessionRepo;
  messages: ScopedMessageRepo;
  agents: ScopedAgentRepo;
  pipelines: ScopedPipelineRepo;
  documents: ScopedDocumentRepo;
  notifications: ScopedNotificationRepo;
  tasks: TaskRepo;
  notes: NoteStore;
  noteScope: NoteScope;
  links: LinkStore;
  artifacts: ArtifactStore;
  knowledge: KnowledgeScope;
  knowledgeOwner: KnowledgeOwner;
  files(): WorkspaceFS;
}

/** The content repositories of `principal`: personal, or the space it acts in. */
export function contentRepos(principal: Principal): ContentRepos {
  if (principal.workspaceKind === 'shared') return spaceRepos(principal);
  const personal = scopedRepos(principal);
  const workspaceId = principal.workspaceId ?? null;
  const noteScope: NoteScope = { kind: 'personal', userId: principal.userId, workspaceId };
  const can = () => undefined;
  return {
    kind: 'personal',
    principal,
    workspaceId,
    role: null,
    can,
    assertOpen: () => undefined,
    sessions: personal.sessions,
    messages: personal.messages,
    agents: personal.agents,
    pipelines: personal.pipelines,
    documents: personal.documents,
    notifications: personal.notifications,
    tasks: personal.tasks,
    notes: new PersonalNoteRepo(noteScope),
    noteScope,
    links: linkStoreFor(noteScope),
    get artifacts() { return personalArtifacts(principal); },
    knowledge: { kind: 'personal', userId: principal.userId, workspaceId },
    knowledgeOwner: { ownerUserId: principal.userId, workspaceId },
    files: () => WorkspaceFS.forRequest(principal),
  };
}

/**
 * Artifacts of the principal's personal workspace; a principal without one
 * has none to reach, and one naming a space (an agent context there) is
 * refused before any query (D3).
 */
function personalArtifacts(principal: Principal): ArtifactStore {
  const workspaceId = principal.workspaceId;
  if (!workspaceId) throw new Error('Artifacts need a resolved workspace');
  return new ArtifactStore(workspaceId, principal.userId, () => undefined, () => assertPersonalWorkspace(workspaceId));
}

/**
 * The content repositories of an agent's tools: `contentRepos` of the
 * agent's principal, so an agent in a space reads and writes the space's
 * rows by the member's role and a personal agent its own (§5.6).
 */
export function reposFor(context: Pick<AgentContext, 'userId' | 'workspaceId' | 'space'>): ContentRepos {
  return contentRepos(agentPrincipal(context));
}
