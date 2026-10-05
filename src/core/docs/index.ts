/**
 * The process's document hub (docs/plans/coworking-spec.md §7.3), wired to
 * the database, the space membership and the gateway.
 */
import { getConfig } from '@/config';
import { getGatewayHub } from '@/core/gateway/hub';
import { membershipVersion } from '@/core/spaces/membership';
import { getMembership } from '@/core/spaces/service';
import { insertRevision, loadSpaceNote, loadSpaceNoteSlug, writeBodyIfUnchanged } from '@/db/repositories/live-documents';
import { userRepository } from '@/db/repositories/user-repository';
import { noteInGuestScope, pathInGuestFolders } from '@/security/space-access';
import { coreLogger } from '@/utils/logger';
import { DocumentHub } from './hub';
import { setProposalChangeListener } from './edit-proposals';
import { leaseViews, listLeases, setLeaseChangeListener } from './file-leases';

let instance: DocumentHub | null = null;

/** Space presence (owned by the rooms code) hears who opened or left a note here. */
let peersListener: (workspaceId: string) => void = () => undefined;

export function setDocPeersListener(fn: (workspaceId: string) => void): void {
  peersListener = fn;
}

export function getDocHub(): DocumentHub {
  if (instance) return instance;
  const gateway = () => getGatewayHub();
  instance = new DocumentHub({
    load: loadSpaceNote,
    writeBody: async (noteId, workspaceId, expectedSha, body, sha) =>
      (await writeBodyIfUnchanged(noteId, workspaceId, expectedSha, body, sha)) !== null,
    insertRevision,
    reindex: async (noteId, editorUserId, previousBody) => {
      const { getNoteService } = await import('@/core/knowledge/notes');
      return getNoteService().refreshSpaceNote(noteId, editorUserId, previousBody);
    },
    userName: async (userId) => (await userRepository.findById(userId))?.username ?? null,
    membership: async (userId, workspaceId, noteId) => {
      const membership = await getMembership(userId, workspaceId);
      if (!membership) return null;
      if (!membership.scope) return membership.role;
      // A guest reads a note of their folders only (S6).
      const note = await loadSpaceNoteSlug(noteId);
      return note && note.workspaceId === workspaceId && noteInGuestScope(note.slug, membership.scope) ? membership.role : null;
    },
    membershipVersion,
    send: (connectionId, message) => gateway().connectionManager.sendToConnection(connectionId, message),
    setResource: (connectionId, resource, on) => {
      const ctx = gateway().connectionManager.getConnection(connectionId)?.context;
      if (!ctx) return;
      if (on) ctx.resources.add(resource);
      else ctx.resources.delete(resource);
    },
    peersChanged: (workspaceId) => {
      try {
        peersListener(workspaceId);
      } catch (err) {
        coreLogger.error({ err, workspaceId }, 'Telling presence about a document change failed');
      }
    },
    limits: () => getConfig().spaces,
    now: () => Date.now(),
  });
  return instance;
}

/**
 * Wire the hub into the gateway: closed connections leave their documents,
 * file lease changes go to the space's `space:<id>` subscribers
 * (`file.leases`), and a note's edit proposal changes to the members who
 * have it open (`doc.proposals` on `doc:<noteId>`). Called once at startup
 * with the message handler.
 */
export function wireDocumentHub(): void {
  setLeaseChangeListener((workspaceId) => {
    void publishLeases(workspaceId);
  });
  setProposalChangeListener((workspaceId, noteId, pending) => {
    getGatewayHub().publishToResource(`doc:${noteId}`, { type: 'doc.proposals', noteId, spaceId: workspaceId, pending });
  });
}

async function publishLeases(workspaceId: string): Promise<void> {
  try {
    const leases = await leaseViews(await listLeases(workspaceId));
    const hub = getGatewayHub();
    const resource = `space:${workspaceId}`;
    // Each subscriber gets its own view: a guest the leases of their folders
    // only (S6); a connection whose membership is gone, nothing.
    const memberships = new Map<string, Awaited<ReturnType<typeof getMembership>>>();
    for (const ctx of hub.connectionManager.getActiveConnections().filter((c) => c.resources.has(resource))) {
      if (!memberships.has(ctx.userId)) memberships.set(ctx.userId, await getMembership(ctx.userId, workspaceId));
      const membership = memberships.get(ctx.userId);
      if (!membership) continue;
      const scope = membership.scope;
      const visible = scope ? leases.filter((l) => pathInGuestFolders(l.path, scope.folders)) : leases;
      hub.connectionManager.sendToConnection(ctx.connectionId, { type: 'file.leases', spaceId: workspaceId, leases: visible });
    }
  } catch (err) {
    coreLogger.error({ err, workspaceId }, 'Publishing file leases failed');
  }
}

/** Test hook: `hub` (or, with null, a fresh one on the next call) is the process's hub. */
export function _setDocHubForTests(hub: DocumentHub | null): void {
  instance = hub;
}
