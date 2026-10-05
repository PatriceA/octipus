'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useGateway } from '@/lib/gateway-context';
import { LiveNoteSession, type LiveNoteState } from '@/lib/live-note';

export interface LiveNote {
  session: LiveNoteSession;
  state: LiveNoteState;
  /** Bumped whenever the session's document was replaced (a new epoch): remount the editor. */
  version: number;
  /** The first `doc.sync` arrived: the document holds the note. */
  synced: boolean;
}

/**
 * The live session of a space note while it is shown (§7.6): joined on
 * mount, left on unmount or when another note is opened. Null when
 * `noteId` is null or live editing is off (personal notes).
 */
export function useLiveNote(noteId: string | null, enabled: boolean): LiveNote | null {
  const gateway = useGateway();
  const { user } = useAuth();
  const [live, setLive] = useState<LiveNote | null>(null);
  const userId = user?.id ?? null;
  const userName = user?.username ?? 'someone';

  useEffect(() => {
    if (!enabled || !noteId || !userId) return;
    const session = new LiveNoteSession(gateway, noteId, { id: userId, name: userName });
    let version = 0;
    let synced = false;
    const offState = session.onState((state) => {
      if (state.status !== 'connecting') synced = true;
      setLive({ session, state, version, synced });
    });
    const offReset = session.onReset(() => {
      version++;
      setLive({ session, state: session.getState(), version, synced });
    });
    return () => {
      offState();
      offReset();
      session.destroy();
      setLive(null);
    };
  }, [gateway, noteId, enabled, userId, userName]);

  // Until its first state change, a session of another note is not this one's.
  return enabled && live && live.session.noteId === noteId ? live : null;
}
