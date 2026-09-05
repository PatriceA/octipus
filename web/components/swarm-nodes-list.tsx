'use client';

/**
 * Swarm Phase 1 sidebar component — flat list of nodes for the current
 * session. Subscribes to `swarm.node_spawned` / `swarm.node_completed`
 * events via the existing WebSocket connection (delivered to this
 * component by the chat page).
 *
 * Deliberately minimal: no tree layout, no per-node cancel. Phase 3 will
 * replace this with the full interactive tree view.
 */

import { Bot, CheckCircle2, Clock, Coins, Layers, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

export interface SwarmNode {
  nodeId: string;
  parentNodeId: string | null;
  kind: 'root' | 'agent' | 'subagent';
  depth: 0 | 1 | 2;
  topicPath: string;
  role: string;
  expertId?: string;
  model: string;
  status: string;
  usedTokens?: number;
  durationMs?: number;
  startedAt: number;
  completedAt?: number;
  taskBriefPreview?: string;
}

export interface SwarmEventMessage {
  type: 'swarm.node_spawned' | 'swarm.node_completed';
  payload: {
    rootSessionId: string;
    nodeId: string;
    parentNodeId: string | null;
    kind: 'root' | 'agent' | 'subagent';
    depth: 0 | 1 | 2;
    topicPath: string;
    role: string;
    expertId?: string;
    model?: string;
    status?: string;
    usedTokens?: number;
    durationMs?: number;
    taskBriefPreview?: string;
    budgets?: { tokens: { cap: number } };
  };
}

export interface SwarmNodesListProps {
  sessionId: string | null;
  /** Latest swarm event from the WS stream. Parent pumps this in. */
  latestEvent?: SwarmEventMessage | null;
}

function statusBadge(status: string) {
  const map: Record<string, { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> }> = {
    running: { label: 'running', cls: 'bg-primary-container/60 text-primary', Icon: Loader2 },
    completed: { label: 'ok', cls: 'bg-tertiary-container/60 text-tertiary', Icon: CheckCircle2 },
    cache_hit: { label: 'cache', cls: 'bg-emerald-900/40 text-tertiary', Icon: CheckCircle2 },
    budget: { label: 'budget', cls: 'bg-amber-900/40 text-warning', Icon: XCircle },
    timeout: { label: 'timeout', cls: 'bg-amber-900/40 text-warning', Icon: Clock },
    denied: { label: 'denied', cls: 'bg-error-container/60 text-error', Icon: XCircle },
    tool_error: { label: 'error', cls: 'bg-error-container/60 text-error', Icon: XCircle },
    contract_failed: { label: 'contract', cls: 'bg-error-container/60 text-error', Icon: XCircle },
    provider_error: { label: 'error', cls: 'bg-error-container/60 text-error', Icon: XCircle },
    cancelled: { label: 'cancelled', cls: 'bg-surface-container-highest text-on-surface-variant', Icon: XCircle },
    concurrency_limit: { label: 'throttled', cls: 'bg-warning-container/60 text-warning', Icon: XCircle },
  };
  return map[status] ?? map.running;
}

function kindIcon(kind: SwarmNode['kind']) {
  switch (kind) {
    case 'root':
      return <Layers className="w-3 h-3" />;
    case 'agent':
      return <Bot className="w-3 h-3" />;
    case 'subagent':
      return <Bot className="w-3 h-3" />;
  }
}

export default function SwarmNodesList({ sessionId, latestEvent }: SwarmNodesListProps) {
  const [nodes, setNodes] = useState<Map<string, SwarmNode>>(new Map());

  // Reset the accumulated node list when switching sessions (render-time seed).
  const [seededSession, setSeededSession] = useState(sessionId);
  if (sessionId !== seededSession) {
    setSeededSession(sessionId);
    setNodes(new Map());
  }

  // Ingest each WS event exactly once into the accumulated node map. Tracking
  // the last-processed event object identity keeps the fold idempotent across
  // re-renders without a setState-in-effect.
  const [lastEvent, setLastEvent] = useState<SwarmEventMessage | null>(null);
  if (
    latestEvent &&
    latestEvent !== lastEvent &&
    sessionId &&
    latestEvent.payload.rootSessionId === sessionId
  ) {
    setLastEvent(latestEvent);
    setNodes((prev) => {
      const next = new Map(prev);
      const p = latestEvent.payload;
      if (latestEvent.type === 'swarm.node_spawned') {
        next.set(p.nodeId, {
          nodeId: p.nodeId,
          parentNodeId: p.parentNodeId,
          kind: p.kind,
          depth: p.depth,
          topicPath: p.topicPath,
          role: p.role,
          expertId: p.expertId,
          model: p.model || '',
          status: p.status || 'running',
          startedAt: Date.now(),
          taskBriefPreview: p.taskBriefPreview,
        });
      } else if (latestEvent.type === 'swarm.node_completed') {
        const existing = next.get(p.nodeId);
        if (existing) {
          next.set(p.nodeId, {
            ...existing,
            status: p.status || 'completed',
            usedTokens: p.usedTokens,
            durationMs: p.durationMs,
            completedAt: Date.now(),
          });
        } else {
          next.set(p.nodeId, {
            nodeId: p.nodeId,
            parentNodeId: p.parentNodeId,
            kind: p.kind,
            depth: p.depth,
            topicPath: p.topicPath,
            role: p.role,
            model: p.model || '',
            status: p.status || 'completed',
            usedTokens: p.usedTokens,
            durationMs: p.durationMs,
            startedAt: Date.now(),
            completedAt: Date.now(),
          });
        }
      }
      return next;
    });
  }

  const sorted = Array.from(nodes.values()).sort((a, b) => a.startedAt - b.startedAt);

  if (sorted.length === 0) {
    return (
      <div className="p-3 text-xs text-on-surface-variant">
        No swarm nodes yet for this session.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 p-2">
      <div className="text-[11px] uppercase tracking-wide text-on-surface-variant px-1 pb-1">
        Swarm ({sorted.length})
      </div>
      {sorted.map((node) => {
        const { label, cls, Icon } = statusBadge(node.status);
        const isRunning = node.status === 'running';
        return (
          <div
            key={node.nodeId}
            className="rounded-md bg-surface-container-highest/60 ring-1 ring-outline-variant/10 px-2 py-1.5 text-xs"
          >
            <div className="flex items-center gap-1.5">
              <span className="text-on-surface-variant">{kindIcon(node.kind)}</span>
              <span className="font-mono text-[10px] text-on-surface-variant">
                d{node.depth}
              </span>
              <span className="font-medium truncate">{node.role}</span>
              <span
                className={cn(
                  'ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium',
                  cls,
                )}
              >
                <Icon className={cn('w-3 h-3', isRunning && 'animate-spin')} />
                {label}
              </span>
            </div>
            {node.topicPath && (
              <div className="mt-1 text-[11px] text-on-surface-variant truncate" title={node.topicPath}>
                {node.topicPath}
              </div>
            )}
            {(node.usedTokens != null || node.durationMs != null) && (
              <div className="mt-1 flex items-center gap-2 text-[10px] text-on-surface-variant">
                {node.usedTokens != null && (
                  <span className="inline-flex items-center gap-0.5">
                    <Coins className="w-2.5 h-2.5" /> {node.usedTokens}
                  </span>
                )}
                {node.durationMs != null && (
                  <span className="inline-flex items-center gap-0.5">
                    <Clock className="w-2.5 h-2.5" /> {Math.round(node.durationMs)}ms
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
