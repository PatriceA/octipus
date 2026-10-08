'use client';

import { useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useGateway } from '@/lib/gateway-context';
import { type LiveMerge, type LiveNoteGateway, LiveNoteSession, type LiveNoteState } from '@/lib/live-note';

export interface LiveNote {
  session: LiveNoteSession;
  state: LiveNoteState;
  /** Bumped whenever the session's document was replaced (a new epoch): remount the editor. */
  version: number;
  /** The first `doc.sync` arrived: the document holds the note. */
  synced: boolean;
}

/** Merge an editor's text the server never got, through the hub (`POST /notes/:id/merge`). */
function mergeThroughServer(noteId: string): LiveMerge {
  return async (base, text) => {
    try {
      await api.post(`/notes/${noteId}/merge`, { base, text });
      return 'merged';
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return 'conflict';
      throw err;
    }
  };
}

/**
 * The live session of a space note while it is shown (§7.6): joined on
 * mount, left on unmount or when another note is opened. Null when
 * `noteId` is null or live editing is off (personal notes).
 *
 * `via` is a space on another install (federation §8.3): its frames go
 * through `remote.frame`, and a text that cannot be merged after a rebuild
 * stays the member's to copy (the host has no merge route for visitors).
 */
export function useLiveNote(noteId: string | null, enabled: boolean, via?: { gateway: LiveNoteGateway; merge: LiveMerge }): LiveNote | null {
  const tabGateway = useGateway();
  const gateway = via?.gateway ?? tabGateway;
  const viaMerge = via?.merge;
  const { user } = useAuth();
  const [live, setLive] = useState<LiveNote | null>(null);
  const userId = user?.id ?? null;
  const userName = user?.username ?? 'someone';

  useEffect(() => {
    if (!enabled || !noteId || !userId) return;
    const session = new LiveNoteSession(gateway, noteId, { id: userId, name: userName }, viaMerge ?? mergeThroughServer(noteId));
    let version = 0;
    // Only a doc.sync makes the document the note: offline at open, or a
    // refused join, leaves it empty (the editor shows the REST copy).
    const offState = session.onState((state) => {
      setLive({ session, state, version, synced: state.synced });
    });
    const offReset = session.onReset(() => {
      version++;
      const state = session.getState();
      setLive({ session, state, version, synced: state.synced });
    });
    return () => {
      offState();
      offReset();
      session.destroy();
      setLive(null);
    };
  }, [gateway, noteId, enabled, userId, userName, viaMerge]);

  // Until its first state change, a session of another note is not this one's.
  return enabled && live && live.session.noteId === noteId ? live : null;
}
