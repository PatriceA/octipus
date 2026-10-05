'use client';

import { Hourglass, Loader2, ShieldQuestion, X } from 'lucide-react';
import type { RoomQueue } from '@/lib/rooms';

interface TurnStripProps {
  queue: RoomQueue;
  myId: string | undefined;
  onCancel: (messageId: string) => void;
}

/**
 * Who Octipus is answering in the room, and who waits: "Octipus — answering
 * Anna" (or "waiting for Anna to approve" while the turn waits on its
 * requester's approval), then the queued requests, each of mine with a
 * cancel. Hidden when the room is idle.
 */
export function TurnStrip({ queue, myId, onCancel }: TurnStripProps) {
  const { running, queued } = queue;
  if (!running && queued.length === 0) return null;
  const name = (requesterId: string, requesterName: string) => (requesterId === myId ? 'you' : requesterName);

  return (
    <div
      role="status"
      data-testid="turn-strip"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5 border-b border-outline-variant/40 bg-surface-container-low font-mono text-[12px]"
    >
      {running && (
        running.waiting ? (
          <span className="flex items-center gap-1.5 text-warning">
            <ShieldQuestion className="w-3.5 h-3.5" />
            Octipus — waiting for {name(running.requesterId, running.requesterName)} to approve
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-on-surface">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
            Octipus — answering {name(running.requesterId, running.requesterName)}
            {running.model && <span className="text-on-surface-variant">· {running.model}</span>}
          </span>
        )
      )}
      {queued.length > 0 && (
        <span className="flex flex-wrap items-center gap-1.5 text-on-surface-variant">
          <Hourglass className="w-3.5 h-3.5" /> queued:
          {queued.map((q) => (
            <span key={q.messageId} data-testid="queued-request" className="inline-flex items-center gap-1 px-1.5 py-px rounded-xs border border-outline-variant/50">
              {name(q.requesterId, q.requesterName)}
              {q.requesterId === myId && (
                <button
                  type="button"
                  onClick={() => onCancel(q.messageId)}
                  aria-label="Cancel my queued request"
                  title="Cancel this request (your post stays)"
                  className="text-on-surface-variant hover:text-error cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
