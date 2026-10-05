/**
 * The process's document hub (docs/plans/coworking-spec.md §7.3), wired to
 * the database, the space membership and the gateway.
 */
import { getConfig } from '@/config';
import { getGatewayHub } from '@/core/gateway/hub';
import { membershipVersion } from '@/core/spaces/membership';
import { getMembership } from '@/core/spaces/service';
import { insertRevision, loadSpaceNote, writeBodyIfUnchanged } from '@/db/repositories/live-documents';
import { coreLogger } from '@/utils/logger';
import { DocumentHub } from './hub';
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
    reindex: async (noteId, editorUserId) => {
      const { getNoteService } = await import('@/core/knowledge/notes');
      await getNoteService().refreshSpaceNote(noteId, editorUserId);
    },
    membership: async (userId, workspaceId) => (await getMembership(userId, workspaceId))?.role ?? null,
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
 * and file lease changes go to the space's `space:<id>` subscribers
 * (`file.leases`). Called once at startup with the message handler.
 */
export function wireDocumentHub(): void {
  setLeaseChangeListener((workspaceId) => {
    void publishLeases(workspaceId);
  });
}

async function publishLeases(workspaceId: string): Promise<void> {
  try {
    const leases = await leaseViews(await listLeases(workspaceId));
    getGatewayHub().publishToResource(`space:${workspaceId}`, { type: 'file.leases', spaceId: workspaceId, leases });
  } catch (err) {
    coreLogger.error({ err, workspaceId }, 'Publishing file leases failed');
  }
}

/** Test hook: `hub` (or, with null, a fresh one on the next call) is the process's hub. */
export function _setDocHubForTests(hub: DocumentHub | null): void {
  instance = hub;
}
