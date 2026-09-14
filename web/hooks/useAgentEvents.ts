'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '@/lib/api';

export interface AgentTimelineEvent {
  id: string;
  type: 'thought' | 'action' | 'observation' | 'error' | 'complete' | 'status_change' | 'permission_request';
  agentId: string;
  data: unknown;
  timestamp: Date;
}

export interface RootTimelineEvent {
  id: string;
  type: 'chat_response' | 'status_update' | 'approval_required' | 'worker_spawned' | 'worker_completed' | 'pipeline_event';
  sessionId: string;
  data: unknown;
  timestamp: Date;
}

interface AgentEventRecord {
  seq: number;
  type: string;
  agentId: string;
  data: unknown;
  timestamp: string;
}

interface EventResponse {
  source?: 'live' | 'persisted';
  nextCursor?: number;
  hasMore?: boolean;
  events: AgentEventRecord[];
}

/** Drain the DB-id cursor until the durable history endpoint reaches its tail. */
export async function fetchPersistedAgentEvents(
  agentId: string,
  after = 0,
): Promise<{ events: AgentEventRecord[]; nextCursor: number }> {
  const events: AgentEventRecord[] = [];
  let cursor = after;
  let hasMore = true;
  while (hasMore) {
    const data = await api.get<EventResponse>(
      `/agents/${encodeURIComponent(agentId)}/events?after=${cursor}&source=persisted`,
    );
    if (!data?.events?.length) break;
    const nextCursor = data.nextCursor ?? data.events[data.events.length - 1].seq;
    if (nextCursor <= cursor) break;
    events.push(...data.events);
    cursor = nextCursor;
    hasMore = data.hasMore === true;
  }
  return { events, nextCursor: cursor };
}

/**
 * Cap on retained live timeline events.
 *
 * This hook polls every 1.5s and appended forever, so a tab left open on a
 * long-running agent grew without bound — and the per-poll dedupe rebuilt a Set
 * over every event ever seen, so the cost grew with it too. A browser tab is
 * the one process in this system that nobody ever restarts.
 *
 * Live activity keeps the old bounded behavior and drops oldest rows first.
 * Archive callers select the persisted stream and retain its full paged history.
 */
const MAX_TIMELINE_EVENTS = 500;

/**
 * Hook to fetch agent events via polling.
 * Polls GET /agents/:id/events?after=<cursor> every 1.5 seconds.
 */
export function useAgentEvents(
  agentId?: string,
  source: 'live' | 'persisted' = 'live',
) {
  const [events, setEvents] = useState<AgentTimelineEvent[]>([]);
  const [rootEvents] = useState<RootTimelineEvent[]>([]);
  const cursorRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset the event list when the agent changes — done during render (the
  // React-endorsed pattern) instead of a setState inside the effect.
  const eventStreamKey = `${agentId ?? ''}:${source}`;
  const [seededStream, setSeededStream] = useState(eventStreamKey);
  if (eventStreamKey !== seededStream) {
    setSeededStream(eventStreamKey);
    setEvents([]);
  }

  useEffect(() => {
    if (!agentId) return;

    cursorRef.current = 0;

    let cancelled = false;
    let fetching = false;

    const fetchEvents = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const after = cursorRef.current;
        const data = source === 'persisted'
          ? await fetchPersistedAgentEvents(agentId, after)
          : await api.get<EventResponse>(
              `/agents/${encodeURIComponent(agentId)}/events?after=${after}&source=live`,
            );
        if (cancelled || !data?.events?.length) return;

        const lastSeq = data.nextCursor ?? data.events[data.events.length - 1].seq;
        if (lastSeq <= after) return;
        cursorRef.current = lastSeq;

        const incoming = data.events.map(e => ({
            id: `evt-${e.seq}`,
            type: e.type as AgentTimelineEvent['type'],
            agentId: e.agentId,
            data: e.data,
            timestamp: new Date(e.timestamp),
        }));

        // Deduplicate by durable id to prevent double-appends (React Strict
        // Mode and overlapping server writes). Archive views retain every
        // row; only the live activity stream remains bounded.
        setEvents(prev => {
          const existingIds = new Set(prev.map(e => e.id));
          const newEvents = incoming.filter(e => !existingIds.has(e.id));
          if (newEvents.length === 0) return prev;
          const next = [...prev, ...newEvents];
          return source === 'live' && next.length > MAX_TIMELINE_EVENTS
            ? next.slice(-MAX_TIMELINE_EVENTS)
            : next;
        });
      } catch {
        // Agent may have been removed — stop polling will happen via cleanup
      } finally {
        fetching = false;
      }
    };

    // Initial fetch
    fetchEvents();

    // Poll every 1.5 seconds
    intervalRef.current = setInterval(fetchEvents, 1500);

    return () => {
      cancelled = true;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [agentId, source]);

  const clearEvents = useCallback(() => {
    setEvents([]);
    cursorRef.current = 0;
  }, []);

  return {
    events,
    rootEvents,
    isConnected: true, // Polling doesn't have a connection concept
    clearEvents,
  };
}
