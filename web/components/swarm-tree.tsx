'use client';

/**
 * Swarm Phase 3 — live hierarchical tree view.
 *
 * Replaces `swarm-nodes-list.tsx` (flat list) with a proper Orchestrator →
 * Agent → Subagent tree rendered from `swarm.node_spawned` /
 * `swarm.node_completed` events pumped in by the chat page.
 *
 * Data flow:
 *  1. On mount / session change, hydrate via `GET /api/swarm/nodes?rootSessionId=…`
 *     so reconnects don't start empty.
 *  2. While mounted, consume `latestEvent` from the parent (WS stream).
 *     Each event mutates a single node in the Map — O(1), no full refetch.
 *  3. Children derived each render from the parent-id index — cheap because
 *     the Map is already shallow-cloned on update.
 *
 * Styling: reuses surface/outline tokens from `agent-timeline.tsx` and the
 * modal primitive at `web/components/ui/modal.tsx`. No new color palette.
 */

import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Coins,
  Eye,
  FileText,
  Layers,
  Loader2,
  StopCircle,
  Wrench,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

// ── Types (re-exported so chat/page.tsx can stay typed) ─────────────────

export interface SwarmTreeNode {
  nodeId: string;
  parentNodeId: string | null;
  kind: 'orchestrator' | 'agent' | 'subagent';
  depth: 0 | 1 | 2;
  topicPath: string;
  role: string;
  expertId?: string;
  expertName?: string;
  model: string;
  status: string;
  tokensUsed?: number;
  tokenCap?: number;
  durationMs?: number;
  startedAt: number;
  completedAt?: number;
  taskBriefPreview?: string;
  /** Only present once we've viewed detail / the event carried output. */
  brief?: unknown;
  result?: unknown;
  error?: string;
}

export interface SwarmEventPayload {
  rootSessionId: string;
  nodeId: string;
  parentNodeId: string | null;
  kind: 'orchestrator' | 'agent' | 'subagent';
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
  output?: unknown;
  error?: string;
}

export interface SwarmTreeEvent {
  type: 'swarm.node_spawned' | 'swarm.node_completed' | string;
  payload: SwarmEventPayload;
}

export interface SwarmTreeProps {
  sessionId: string | null;
  /** Append-only queue of swarm events from the WS stream. The component
   *  tracks how many it has already consumed via a ref; the parent only
   *  needs to append. A queue (rather than a single "latest" event) avoids
   *  losing intermediate events when React 18 batches multiple parent
   *  setState calls into one render. */
  events?: SwarmTreeEvent[];
  /** Called when the user clicks "view events" on a node. */
  onViewEvents?: (nodeId: string) => void;
  /** Called once REST hydration finishes with the snapshot totals. Lets the
   *  chat page seed Session Stats on cold page loads. */
  onHydratedTotals?: (totals: { tokens: number; durationMs: number }) => void;
}

// ── Visual helpers ──────────────────────────────────────────────────────

function statusBadge(status: string): {
  label: string;
  cls: string;
  Icon: React.ComponentType<{ className?: string }>;
} {
  const map: Record<string, { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> }> = {
    running: { label: 'running', cls: 'bg-primary-container/60 text-primary', Icon: Loader2 },
    completed: { label: 'ok', cls: 'bg-tertiary-container/60 text-tertiary', Icon: CheckCircle2 },
    cache_hit: { label: 'cache', cls: 'bg-emerald-900/40 text-tertiary', Icon: CheckCircle2 },
    budget: { label: 'budget', cls: 'bg-amber-900/40 text-warning', Icon: XCircle },
    timeout: { label: 'timeout', cls: 'bg-amber-900/40 text-warning', Icon: Clock },
    denied: { label: 'denied', cls: 'bg-error-container/60 text-error', Icon: XCircle },
    tool_error: { label: 'error', cls: 'bg-error-container/60 text-error', Icon: XCircle },
    provider_error: { label: 'error', cls: 'bg-error-container/60 text-error', Icon: XCircle },
    cancelled: { label: 'cancelled', cls: 'bg-surface-container-highest text-on-surface-variant', Icon: XCircle },
    concurrency_limit: { label: 'throttled', cls: 'bg-warning-container/60 text-warning', Icon: XCircle },
  };
  return map[status] ?? map.running;
}

function kindIcon(kind: SwarmTreeNode['kind']) {
  switch (kind) {
    case 'orchestrator':
      // Emoji preferred in design doc; Layers icon is the fallback.
      return <Layers className="w-3 h-3" />;
    case 'agent':
      return <Bot className="w-3 h-3" />;
    case 'subagent':
      return <Wrench className="w-3 h-3" />;
  }
}

function kindEmoji(kind: SwarmTreeNode['kind']): string {
  return kind === 'orchestrator' ? '📦' : kind === 'agent' ? '🤖' : '🔧';
}

function formatDuration(ms: number): string {
  // Guard against clock skew / out-of-order events producing negative durations.
  const safe = Math.max(0, ms);
  if (safe < 1000) return `${Math.round(safe)}ms`;
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)}s`;
  return `${Math.floor(safe / 60_000)}m ${Math.round((safe % 60_000) / 1000)}s`;
}

// ── Rehydration fetch ───────────────────────────────────────────────────

interface ApiSwarmNode {
  id: string;
  rootSessionId: string;
  parentNodeId: string | null;
  depth: number;
  kind: 'orchestrator' | 'agent' | 'subagent';
  role: string;
  expertId?: string | null;
  topicPath: string;
  model: string;
  status: string;
  tokenCap: number;
  tokensUsed: number;
  taskBriefPreview?: string | null;
  result?: unknown;
  createdAt: string;
  completedAt?: string | null;
  error?: string | null;
}

function apiNodeToTreeNode(n: ApiSwarmNode): SwarmTreeNode {
  const started = new Date(n.createdAt).getTime();
  const completed = n.completedAt ? new Date(n.completedAt).getTime() : undefined;
  return {
    nodeId: n.id,
    parentNodeId: n.parentNodeId,
    kind: n.kind,
    depth: n.depth as 0 | 1 | 2,
    topicPath: n.topicPath,
    role: n.role,
    expertId: n.expertId ?? undefined,
    model: n.model,
    status: n.status,
    tokensUsed: n.tokensUsed,
    tokenCap: n.tokenCap,
    startedAt: started,
    completedAt: completed,
    durationMs: completed ? completed - started : undefined,
    taskBriefPreview: n.taskBriefPreview ?? undefined,
    result: n.result ?? undefined,
    error: n.error ?? undefined,
  };
}

// ── Main component ──────────────────────────────────────────────────────

export default function SwarmTree({
  sessionId,
  events,
  onViewEvents,
  onHydratedTotals,
}: SwarmTreeProps) {
  const [nodes, setNodes] = useState<Map<string, SwarmTreeNode>>(new Map());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const [detailNode, setDetailNode] = useState<SwarmTreeNode | null>(null);
  const [detailMode, setDetailMode] = useState<'brief' | 'result' | null>(null);
  const [loading, setLoading] = useState(() => !!sessionId);
  // Index into the parent's events queue for what we've already folded into
  // `nodes`. Survives batched parent updates: if the queue grows by N entries
  // between renders, the next effect run consumes all N at once.
  const processedIdxRef = useRef(0);

  // Keep the latest `onHydratedTotals` in a ref so the hydrate effect can call
  // it without listing it as a dependency (which would re-run the fetch every
  // time the parent passes a fresh callback).
  const onHydratedTotalsRef = useRef(onHydratedTotals);
  useEffect(() => {
    onHydratedTotalsRef.current = onHydratedTotals;
  }, [onHydratedTotals]);

  // Clear the tree and arm the loading flag when the session changes — during
  // render (the React-endorsed alternative to a setState in the hydrate effect).
  const [seededSession, setSeededSession] = useState(sessionId);
  if (sessionId !== seededSession) {
    setSeededSession(sessionId);
    setNodes(new Map());
    setLoading(!!sessionId);
  }

  // Hydrate from REST when the session changes (covers WS replay gap).
  useEffect(() => {
    // New session: forget how far we've drained the parent's event queue.
    // Without this reset, switching sessions would skip over fresh events
    // because the index still pointed past them. (The tree itself is cleared
    // during render above.)
    processedIdxRef.current = 0;
    if (!sessionId) {
      return;
    }
    let cancelled = false;
    api
      .get<{ nodes?: ApiSwarmNode[]; error?: string }>(`/swarm/nodes?rootSessionId=${sessionId}`)
      .then((data) => {
        if (cancelled) return;
        if (data?.nodes) {
          const next = new Map<string, SwarmTreeNode>();
          let tokens = 0;
          let durationMs = 0;
          for (const n of data.nodes) {
            const node = apiNodeToTreeNode(n);
            next.set(n.id, node);
            if (typeof n.tokensUsed === 'number') tokens += n.tokensUsed;
            // Sum only orchestrator runtimes — sub-agent durations are
            // already encompassed by their orchestrator's wall-clock time.
            // Summing every node double-counts and inflates the metric.
            if (node.durationMs && node.kind === 'orchestrator') durationMs += node.durationMs;
          }
          setNodes(next);
          onHydratedTotalsRef.current?.({ tokens, durationMs });
        }
      })
      .catch(() => {
        // Non-fatal — the WS stream will backfill as events arrive.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Tick for live wall-clock on running nodes. Cheap — only re-renders numbers.
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Self-heal poll: while any node is `running`, refetch the DB-authoritative
  // status every 4s. The WS stream is the fast path, but it can drop events
  // when React 18 batches multiple rapid setLatestSwarmEvent calls into a
  // single render (only the most recent payload survives the batch). That
  // showed up as a child whose `running` row in the tree never flipped to
  // `completed` even though chat already saw the agent finish. Polling is a
  // cheap safety net — it stops the moment everything is terminal.
  useEffect(() => {
    if (!sessionId) return;
    const anyRunning = Array.from(nodes.values()).some((n) => n.status === 'running');
    if (!anyRunning) return;
    const interval = setInterval(async () => {
      try {
        const data = await api.get<{ nodes?: ApiSwarmNode[] }>(`/swarm/nodes?rootSessionId=${sessionId}`);
        if (!data?.nodes) return;
        setNodes((prev) => {
          const next = new Map(prev);
          for (const n of data.nodes!) {
            const existing = next.get(n.id);
            // Only patch when the DB row reports a TERMINAL status the
            // local map doesn't already know — avoids stomping fresh WS
            // updates that the poll might have raced.
            if (n.status !== 'running' && existing?.status === 'running') {
              next.set(n.id, apiNodeToTreeNode(n));
            } else if (!existing) {
              next.set(n.id, apiNodeToTreeNode(n));
            }
          }
          return next;
        });
      } catch {
        // Non-fatal — try again next tick.
      }
    }, 4000);
    return () => clearInterval(interval);
  }, [sessionId, nodes]);

  // Drain incoming WS events from the parent's queue. The parent always
  // appends, so on each render we process indices [processedIdxRef, length).
  // Folding every new event in a single `setNodes` call means rapid bursts
  // get applied atomically — earlier renders that batched multiple parent
  // setStates used to drop intermediate spawns.
  useEffect(() => {
    if (!sessionId || !events) return;
    // Parent may trim the queue when it grows past its cap; if the length
    // shrank below our cursor, treat it as a fresh queue. Reprocessing is
    // safe because spawn/complete updates are keyed by nodeId and idempotent.
    if (events.length < processedIdxRef.current) processedIdxRef.current = 0;
    if (events.length <= processedIdxRef.current) return;

    const fresh = events.slice(processedIdxRef.current);
    processedIdxRef.current = events.length;

    setNodes((prev) => {
      const next = new Map(prev);
      for (const evt of fresh) {
        const p = evt.payload;
        if (p.rootSessionId !== sessionId) continue;
        const existing = next.get(p.nodeId);

        if (evt.type === 'swarm.node_spawned') {
          next.set(p.nodeId, {
            ...(existing ?? {
              nodeId: p.nodeId,
              parentNodeId: p.parentNodeId,
              kind: p.kind,
              depth: p.depth,
              topicPath: p.topicPath,
              role: p.role,
              model: p.model || '',
              startedAt: Date.now(),
            }),
            parentNodeId: p.parentNodeId,
            kind: p.kind,
            depth: p.depth,
            topicPath: p.topicPath,
            role: p.role,
            expertId: p.expertId ?? existing?.expertId,
            model: p.model || existing?.model || '',
            status: p.status || 'running',
            tokenCap: p.budgets?.tokens?.cap ?? existing?.tokenCap,
            startedAt: existing?.startedAt ?? Date.now(),
            taskBriefPreview: p.taskBriefPreview ?? existing?.taskBriefPreview,
          });
        } else if (evt.type === 'swarm.node_completed') {
          // Always build a full `SwarmTreeNode` so property accesses below
          // compile without a fallback-vs-existing union. Unknown optionals
          // default to undefined; `existing` values win when present.
          const base: SwarmTreeNode = existing ?? {
            nodeId: p.nodeId,
            parentNodeId: p.parentNodeId,
            kind: p.kind,
            depth: p.depth,
            topicPath: p.topicPath,
            role: p.role,
            model: p.model || '',
            status: p.status || 'running',
            startedAt: Date.now(),
          };
          next.set(p.nodeId, {
            ...base,
            status: p.status || 'completed',
            tokensUsed: p.usedTokens ?? base.tokensUsed,
            durationMs: p.durationMs ?? base.durationMs,
            completedAt: Date.now(),
            result: p.output ?? base.result,
            error: p.error ?? base.error,
          });
        }
      }
      return next;
    });
  }, [events, sessionId]);

  // Build parent-id index once per render. O(n) on nodes — fine for trees
  // of the target size (fan-out cap × depth ≤ 2 = O(100) max).
  const { roots, childrenOf } = useMemo(() => {
    const childrenOf = new Map<string | null, SwarmTreeNode[]>();
    const roots: SwarmTreeNode[] = [];
    for (const node of nodes.values()) {
      const key = node.parentNodeId;
      const list = childrenOf.get(key);
      if (list) list.push(node);
      else childrenOf.set(key, [node]);
      if (!key || !nodes.has(key)) roots.push(node);
    }
    const sort = (a: SwarmTreeNode, b: SwarmTreeNode) => a.startedAt - b.startedAt;
    for (const list of childrenOf.values()) list.sort(sort);
    roots.sort(sort);
    return { roots, childrenOf };
  }, [nodes]);

  const toggleCollapse = (nodeId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const handleCancel = async (node: SwarmTreeNode) => {
    // Always cancel from the orchestrator (root). User mental model is
    // "cancel the swarm" — cancelling a single child leaf with the
    // orchestrator still running was confusing: the orchestrator would
    // finalize its task even though the user thought they'd stopped
    // everything. Walk up the parent chain to find the root, then
    // cascade from there. Per-node granular cancel was technically
    // working but UX-wrong; if granularity is needed later we can
    // surface it as a separate menu action.
    let target = node;
    const guard = new Set<string>();
    while (target.parentNodeId && !guard.has(target.nodeId)) {
      guard.add(target.nodeId);
      const parent = nodes.get(target.parentNodeId);
      if (!parent) break;
      target = parent;
    }
    if (!confirm(
      target.nodeId === node.nodeId
        ? `Cancel ${target.kind} "${target.role}" (and descendants)?`
        : `Cancel the whole swarm (root ${target.kind} "${target.role}" and all descendants)?`,
    )) {
      return;
    }
    try {
      await api.post(`/swarm/nodes/${target.nodeId}/cancel`);
      // Optimistic: the backend will emit a `swarm.node_completed` that
      // flips status → 'cancelled' shortly. Nothing else to do here.
    } catch (err) {
      console.error('Swarm cancel failed', err);
      alert('Failed to cancel swarm node');
    }
  };

  const openDetail = (node: SwarmTreeNode, mode: 'brief' | 'result') => {
    setDetailNode(node);
    setDetailMode(mode);
  };
  const closeDetail = () => {
    setDetailNode(null);
    setDetailMode(null);
  };

  // ── Rendering ─────────────────────────────────────────────────────────

  if (!sessionId) {
    return (
      <div className="p-3 text-xs text-on-surface-variant">No session selected.</div>
    );
  }

  if (loading && nodes.size === 0) {
    return (
      <div className="p-3 text-xs text-on-surface-variant flex items-center gap-2">
        <Loader2 className="w-3 h-3 animate-spin" />
        Loading swarm tree…
      </div>
    );
  }

  if (roots.length === 0) {
    return (
      <div className="p-3 text-xs text-on-surface-variant">
        No swarm nodes yet for this session.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 p-2">
      <div className="text-[11px] uppercase tracking-wide text-on-surface-variant px-1 pb-1">
        Swarm Tree ({nodes.size})
      </div>
      <div className="flex flex-col gap-1">
        {roots.map((root) => (
          <TreeNode
            key={root.nodeId}
            node={root}
            level={0}
            childrenOf={childrenOf}
            collapsed={collapsed}
            toggleCollapse={toggleCollapse}
            onCancel={handleCancel}
            onViewBrief={(n) => openDetail(n, 'brief')}
            onViewResult={(n) => openDetail(n, 'result')}
            onViewEvents={onViewEvents}
            now={now}
          />
        ))}
      </div>

      <Modal
        open={!!detailNode && !!detailMode}
        onClose={closeDetail}
        title={
          detailNode
            ? `${kindEmoji(detailNode.kind)} ${detailNode.role} — ${
                detailMode === 'brief' ? 'Task Brief' : 'Child Result'
              }`
            : undefined
        }
        maxWidth="lg"
      >
        {detailNode && detailMode === 'brief' && (
          <div className="space-y-3">
            <div className="text-xs text-on-surface-variant">Topic</div>
            <div className="font-mono text-xs wrap-break-word">{detailNode.topicPath}</div>
            <div className="text-xs text-on-surface-variant mt-3">Task brief</div>
            <pre className="font-mono text-[11px] whitespace-pre-wrap bg-surface-container-highest/60 rounded p-2 max-h-[60vh] overflow-auto">
              {detailNode.taskBriefPreview || '(not available)'}
            </pre>
          </div>
        )}
        {detailNode && detailMode === 'result' && (
          <div className="space-y-3">
            <div className="text-xs text-on-surface-variant">Status: {detailNode.status}</div>
            {detailNode.error && (
              <div className="text-xs text-error">Error: {detailNode.error}</div>
            )}
            <pre className="font-mono text-[11px] whitespace-pre-wrap bg-surface-container-highest/60 rounded p-2 max-h-72 overflow-auto">
              {detailNode.result
                ? JSON.stringify(detailNode.result, null, 2)
                : '(no result yet)'}
            </pre>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ── Per-node recursive row ──────────────────────────────────────────────

interface TreeNodeProps {
  node: SwarmTreeNode;
  level: number;
  childrenOf: Map<string | null, SwarmTreeNode[]>;
  collapsed: Set<string>;
  toggleCollapse: (id: string) => void;
  onCancel: (n: SwarmTreeNode) => void;
  onViewBrief: (n: SwarmTreeNode) => void;
  onViewResult: (n: SwarmTreeNode) => void;
  onViewEvents?: (id: string) => void;
  /** Current wall-clock time (ms); drives the live elapsed counter on running nodes. */
  now: number;
}

function TreeNode({
  node,
  level,
  childrenOf,
  collapsed,
  toggleCollapse,
  onCancel,
  onViewBrief,
  onViewResult,
  onViewEvents,
  now,
}: TreeNodeProps) {
  const kids = childrenOf.get(node.nodeId) ?? [];
  const hasKids = kids.length > 0;
  const isCollapsed = collapsed.has(node.nodeId);
  const { label, cls, Icon } = statusBadge(node.status);
  const isRunning = node.status === 'running';
  const isRoot = node.kind === 'orchestrator';

  const elapsed = node.completedAt
    ? Math.max(0, node.durationMs ?? 0)
    : Math.max(0, now - node.startedAt);

  return (
    <div>
      <div
        className={cn(
          'rounded-md bg-surface-container-highest/60 ring-1 ring-outline-variant/10 px-2 py-1.5 text-xs',
          'hover:bg-surface-container-highest/80 transition-colors',
        )}
        style={{ marginLeft: level * 14 }}
      >
        <div className="flex items-center gap-1.5">
          {/* Collapse chevron — only when node has children. */}
          {hasKids ? (
            <button
              onClick={() => toggleCollapse(node.nodeId)}
              className="text-on-surface-variant hover:text-on-surface cursor-pointer"
              title={isCollapsed ? 'Expand' : 'Collapse'}
            >
              {isCollapsed ? (
                <ChevronRight className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
            </button>
          ) : (
            <span className="w-3" />
          )}

          <span className="text-on-surface-variant">{kindIcon(node.kind)}</span>
          <span className="font-mono text-[10px] text-on-surface-variant">d{node.depth}</span>
          <span className="font-medium truncate" title={node.role}>
            {node.role}
          </span>
          {node.expertName && (
            <span className="inline-flex items-center px-1 py-0.5 rounded bg-surface-container-high text-[10px] text-on-surface-variant">
              {node.expertName}
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-1">
            <span
              className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium',
                cls,
              )}
            >
              <Icon className={cn('w-3 h-3', isRunning && 'animate-spin')} />
              {label}
            </span>
          </span>
        </div>

        {node.topicPath && (
          <div
            className="mt-1 text-[11px] text-on-surface-variant truncate"
            title={node.topicPath}
          >
            {node.topicPath}
          </div>
        )}

        <div className="mt-1 flex items-center gap-2 text-[10px] text-on-surface-variant flex-wrap">
          {node.model && (
            <span className="font-mono truncate" title={node.model}>
              {node.model}
            </span>
          )}
          {(node.tokensUsed != null || node.tokenCap != null) && (
            <span className="inline-flex items-center gap-0.5">
              <Coins className="w-2.5 h-2.5" />
              {node.tokensUsed ?? 0}
              {node.tokenCap ? `/${node.tokenCap}` : ''}
            </span>
          )}
          <span className="inline-flex items-center gap-0.5">
            <Clock className="w-2.5 h-2.5" />
            {formatDuration(elapsed)}
          </span>
        </div>

        {/* Action row. Cancel only visible on running. View brief/result/events always. */}
        <div className="mt-1.5 flex items-center gap-1">
          <button
            onClick={() => onViewBrief(node)}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high cursor-pointer"
            title="View task brief"
          >
            <FileText className="w-2.5 h-2.5" />
            brief
          </button>
          <button
            onClick={() => onViewResult(node)}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high cursor-pointer"
            title="View child result"
          >
            <Eye className="w-2.5 h-2.5" />
            result
          </button>
          {onViewEvents && (
            <button
              onClick={() => onViewEvents(node.nodeId)}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high cursor-pointer"
              title="View agent events"
            >
              events
            </button>
          )}
          {isRunning && (
            <button
              onClick={() => onCancel(node)}
              className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-error hover:bg-error-container/60 cursor-pointer"
              title={isRoot ? 'Cancel swarm (cascades to all children)' : 'Cancel this node + descendants'}
            >
              <StopCircle className="w-2.5 h-2.5" />
              {isRoot ? 'cancel swarm' : 'cancel'}
            </button>
          )}
        </div>
      </div>

      {hasKids && !isCollapsed && (
        <div className="flex flex-col gap-1 mt-1">
          {kids.map((child) => (
            <TreeNode
              key={child.nodeId}
              node={child}
              level={level + 1}
              childrenOf={childrenOf}
              collapsed={collapsed}
              toggleCollapse={toggleCollapse}
              onCancel={onCancel}
              onViewBrief={onViewBrief}
              onViewResult={onViewResult}
              onViewEvents={onViewEvents}
              now={now}
            />
          ))}
        </div>
      )}
    </div>
  );
}
