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

export interface OrchestratorTimelineEvent {
  id: string;
  type: 'chat_response' | 'status_update' | 'approval_required' | 'worker_spawned' | 'worker_completed' | 'pipeline_event';
  sessionId: string;
  data: unknown;
  timestamp: Date;
}

interface EventResponse {
  events: Array<{
    seq: number;
    type: string;
    agentId: string;
    data: unknown;
    timestamp: string;
  }>;
}

/**
 * Cap on retained timeline events.
 *
 * This hook polls every 1.5s and appended forever, so a tab left open on a
 * long-running agent grew without bound — and the per-poll dedupe rebuilt a Set
 * over every event ever seen, so the cost grew with it too. A browser tab is
 * the one process in this system that nobody ever restarts.
 *
 * The timeline is a live activity view, not an archive: the full history stays
 * in `agent_events` and is refetchable by cursor. Oldest are dropped first.
 */
const MAX_TIMELINE_EVENTS = 500;

/**
 * Hook to fetch agent events via polling.
 * Polls GET /agents/:id/events?after=<cursor> every 1.5 seconds.
 */
export function useAgentEvents(agentId?: string) {
  const [events, setEvents] = useState<AgentTimelineEvent[]>([]);
  const [orchestratorEvents] = useState<OrchestratorTimelineEvent[]>([]);
  const cursorRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset the event list when the agent changes — done during render (the
  // React-endorsed pattern) instead of a setState inside the effect.
  const [seededAgent, setSeededAgent] = useState(agentId);
  if (agentId !== seededAgent) {
    setSeededAgent(agentId);
    setEvents([]);
  }

  useEffect(() => {
    if (!agentId) return;

    cursorRef.current = 0;

    let cancelled = false;

    const fetchEvents = async () => {
      try {
        const data = await api.get<EventResponse>(
          `/agents/${agentId}/events?after=${cursorRef.current}`
        );
        if (cancelled) return;
        if (data?.events?.length) {
          // Update cursor to the last seq
          const lastSeq = data.events[data.events.length - 1].seq;
          cursorRef.current = lastSeq;

          const incoming = data.events.map(e => ({
            id: `evt-${e.seq}`,
            type: e.type as AgentTimelineEvent['type'],
            agentId: e.agentId,
            data: e.data,
            timestamp: new Date(e.timestamp),
          }));

          // Deduplicate by id to prevent double-appends (React Strict Mode)
          setEvents(prev => {
            const existingIds = new Set(prev.map(e => e.id));
            const newEvents = incoming.filter(e => !existingIds.has(e.id));
            if (newEvents.length === 0) return prev;
            const next = [...prev, ...newEvents];
            // Bounded retention — see MAX_TIMELINE_EVENTS.
            return next.length > MAX_TIMELINE_EVENTS ? next.slice(-MAX_TIMELINE_EVENTS) : next;
          });
        }
      } catch {
        // Agent may have been removed — stop polling will happen via cleanup
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
  }, [agentId]);

  const clearEvents = useCallback(() => {
    setEvents([]);
    cursorRef.current = 0;
  }, []);

  return {
    events,
    orchestratorEvents,
    isConnected: true, // Polling doesn't have a connection concept
    clearEvents,
  };
}
