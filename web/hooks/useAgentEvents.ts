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
 * Hook to fetch agent events via polling.
 * Polls GET /agents/:id/events?after=<cursor> every 1.5 seconds.
 */
export function useAgentEvents(agentId?: string) {
  const [events, setEvents] = useState<AgentTimelineEvent[]>([]);
  const [orchestratorEvents] = useState<OrchestratorTimelineEvent[]>([]);
  const cursorRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!agentId) return;

    // Reset on agent change
    setEvents([]);
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
            return [...prev, ...newEvents];
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
