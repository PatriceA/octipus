'use client';

import { PanelRight, PanelRightClose } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import MessageTimeline, {
  type ChatMessageData,
  type MessageMetadata,
  type TeamState,
  type TrackedAgent,
} from '@/components/chat/message-timeline';
import { NewSessionDialog, type NewSessionOptions } from '@/components/chat/new-session-dialog';
import PromptInput, { type Attachment } from '@/components/chat/prompt-input';
import { type SessionInfo, SessionList } from '@/components/chat/session-list';
import SidePanel from '@/components/chat/side-panel';
import type { SwarmTreeEvent } from '@/components/swarm-tree';
import { api, createAuthenticatedWebSocket, getApiUrl } from '@/lib/api';
import { usePermissions } from '@/lib/permission-context';
import { useWorkspace } from '@/lib/workspace-context';

interface ToolCallInfo {
  id: string;
  name: string;
  argsSummary?: string;
  status?: string;
  durationMs?: number;
  resultPreview?: string;
  error?: string;
}

export interface FileChange {
  path: string;
  action: string;
  agentId: string;
  agentRole: string;
  timestamp: string;
  content?: string;
  oldContent?: string;
}

// Per-session state
interface SessionState {
  messages: ChatMessageData[];
  trackedAgents: Map<string, TrackedAgent>;
  teams: Map<string, TeamState>;
  totalTokens: number;
  /** Cumulative wall-clock across all completed swarm nodes (ms). */
  swarmDurationMs: number;
  fileChanges: FileChange[];
}

// Module-level guard to prevent React Strict Mode double WebSocket connections
let wsInstance: WebSocket | null = null;

const STORAGE_KEY_ACTIVE = 'chat_active_session';

function welcomeMessage(): ChatMessageData {
  return {
    id: '0',
    role: 'system',
    content: 'Welcome! I\'m your AI assistant. I\'ll route your requests to the right specialist. How can I help you today?',
    timestamp: new Date(),
  };
}

function newSessionState(): SessionState {
  return {
    messages: [welcomeMessage()],
    trackedAgents: new Map(),
    teams: new Map(),
    totalTokens: 0,
    swarmDurationMs: 0,
    fileChanges: [],
  };
}

/** Timestamp (ms) of the most recent user message in a session, or 0. */
function latestUserMessageTime(messages: ChatMessageData[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return new Date(messages[i].timestamp).getTime();
    }
  }
  return 0;
}

interface Preset {
  id: string;
  name: string;
  description?: string;
  role: string;
}

export default function ChatPage() {
  const { pushPermission, pushApproval } = usePermissions();
  const { activeWorkspace } = useWorkspace();
  const [mounted, setMounted] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const deletedSessionsRef = useRef<Set<string>>(new Set());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionStates, setSessionStates] = useState<Map<string, SessionState>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'connecting'>('connecting');
  const [models, setModels] = useState<Array<{ name: string; isDefault: boolean }>>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [showSidePanel, setShowSidePanel] = useState(true);
  const [showNewSessionDialog, setShowNewSessionDialog] = useState(false);
  const [maxTokenBudget, setMaxTokenBudget] = useState(0);
  // Append-only queue of swarm events from the WS stream. We used to hold the
  // single "latest" event in state, but React 18 batches multiple state
  // updates inside an onmessage burst — when two swarm events arrived in the
  // same render, only the most recent one survived, so the first spawn went
  // unrendered. The SwarmTree consumer tracks its own processed index, so a
  // queue never loses events even under batching.
  const [swarmEvents, setSwarmEvents] = useState<SwarmTreeEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  // Active session state
  const activeState = activeSessionId ? sessionStates.get(activeSessionId) : null;
  const messages = activeState?.messages || [welcomeMessage()];
  const trackedAgents = activeState?.trackedAgents || new Map();
  const teams = activeState?.teams || new Map();
  const sessionTotalTokens = activeState?.totalTokens || 0;
  const swarmDurationMs = activeState?.swarmDurationMs || 0;

  // Update a session's state
  const updateSessionState = useCallback((sessionId: string, updater: (prev: SessionState) => SessionState) => {
    setSessionStates(prev => {
      const next = new Map(prev);
      const current = next.get(sessionId) || newSessionState();
      next.set(sessionId, updater(current));
      return next;
    });
  }, []);

  // Transient narration messages — pop in, then fade out after a short
  // TTL. Used for orchestrator dispatch lines AND per-tool stream
  // updates ("data arm calls read_file", "data arm · read_file ✓ 0.2s").
  // Keeps the chat readable instead of growing an ever-longer log of
  // ephemeral activity. ~8s feels right — long enough to read, short
  // enough that two siblings don't pile on top of each other.
  const NARRATION_TTL_MS = 8000;
  const pushTransientNarration = useCallback((sessionId: string, text: string, timestamp?: Date) => {
    if (!sessionId || !text.trim()) return;
    const id = `narr-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    updateSessionState(sessionId, (prev) => ({
      ...prev,
      messages: [
        ...prev.messages,
        {
          id,
          role: 'narration',
          content: text,
          timestamp: timestamp ?? new Date(),
        },
      ],
    }));
    setTimeout(() => {
      updateSessionState(sessionId, (prev) => ({
        ...prev,
        messages: prev.messages.filter((m) => m.id !== id),
      }));
    }, NARRATION_TTL_MS);
  }, [updateSessionState]);

  // Load sessions from backend
  const loadSessions = useCallback(async () => {
    try {
      const data = await api.get<{ sessions: Array<{ id: string; title: string; updatedAt: string; messageCount: number; tokenCount?: number; status: string; channelType?: string; context?: { devMode?: boolean; projectName?: string } }>; maxTokenBudget?: number }>('/sessions');
      if (data?.maxTokenBudget != null) setMaxTokenBudget(data.maxTokenBudget);
      if (data?.sessions?.length) {
        const items: SessionInfo[] = data.sessions
          .filter(s => s.status === 'active')
          .filter(s => !deletedSessionsRef.current.has(s.id))
          .slice(0, 50)
          .map(s => ({
            id: s.id,
            title: s.title || 'Untitled',
            updatedAt: s.updatedAt,
            messageCount: s.messageCount,
            tokenCount: s.tokenCount || 0,
            status: s.status,
            devMode: s.context?.devMode,
            projectName: s.context?.projectName,
            channelType: s.channelType,
          }));
        setSessions(items);

        // Sync token counts into session states
        for (const s of items) {
          if (s.tokenCount > 0) {
            updateSessionState(s.id, (prev) => ({
              ...prev,
              totalTokens: Math.max(prev.totalTokens, s.tokenCount),
            }));
          }
        }

        return items;
      }
    } catch {}
    return [];
  }, [updateSessionState]);

  // Load messages for a session
  const loadSessionMessages = useCallback(async (sessionId: string) => {
    try {
      const data = await api.get<{ messages: Array<{ id: string; role: string; content: string; createdAt: string }> }>(
        `/sessions/${sessionId}/messages?roles=user,assistant,system&limit=10000`
      );
      const msgs = data?.messages?.length
        ? data.messages.map((m) => ({
            id: m.id,
            role: m.role as ChatMessageData['role'],
            content: m.content,
            timestamp: new Date(m.createdAt),
          }))
        : [welcomeMessage()];

      // Restore agent activity and file changes for this session
      const restoredAgents = new Map<string, TrackedAgent>();
      const restoredFileChanges: FileChange[] = [];
      try {
        const agentData = await api.get<{ agents: Array<{ id: string; sessionId: string; role: string; model: string; status: string; createdAt: string; completedAt?: string; durationMs?: number; iteration: number }> }>(`/agents?sessionId=${encodeURIComponent(sessionId)}`);
        const sessionAgents = agentData?.agents || [];
        for (const a of sessionAgents) {
          const toolCalls: Array<{ id: string; name: string; argsSummary?: string }> = [];
          let cliIterations = 0;
          try {
            const evData = await api.get<{ events: Array<{ type: string; data: any }> }>(`/agents/${a.id}/events`);
            for (const ev of evData?.events || []) {
              if (ev.type === 'action') {
                // Standard agent tool calls (array format)
                if (ev.data?.toolCalls) {
                  toolCalls.push(...ev.data.toolCalls.map((tc: any) => ({
                    id: tc.id || Date.now().toString(),
                    name: tc.name,
                    argsSummary: tc.argsSummary,
                  })));
                  // File changes come from explicit `file_change` events
                  // emitted by tool-executor.ts after a successful write — see
                  // the branch below. Don't try to parse paths out of
                  // `argsSummary` here: the summary is truncated to 120 chars
                  // and uses ", " as the field separator, so paths containing
                  // spaces (e.g. "C:/Users/patri/Github Reps/...") get cut off
                  // at the first space and we end up with a fake duplicate
                  // entry like "C:/Users/patri/Github" alongside the real one.
                }
                // CLI agent tool use (single tool format from cli_tool_use events)
                else if (ev.data?.type === 'cli_tool_use' && ev.data?.toolName) {
                  cliIterations++;
                  toolCalls.push({
                    id: Date.now().toString() + cliIterations,
                    name: String(ev.data.toolName),
                    argsSummary: ev.data.args ? JSON.stringify(ev.data.args).slice(0, 80) : undefined,
                  });
                }
                // File change events — restore for persistence across page loads
                else if (ev.data?.type === 'file_change' && ev.data?.path) {
                  restoredFileChanges.push({
                    path: String(ev.data.path),
                    action: String(ev.data.action || 'write'),
                    agentId: a.id,
                    agentRole: a.role,
                    timestamp: a.createdAt,
                    content: ev.data.content as string | undefined,
                    oldContent: ev.data.oldContent as string | undefined,
                  });
                }
              }
            }
          } catch {}
          const startTime = new Date(a.createdAt).getTime();
          const isFinished = a.status !== 'running' && a.status !== 'idle';
          const endTime = isFinished
            ? (a.completedAt ? new Date(a.completedAt).getTime() : (a.durationMs != null ? startTime + a.durationMs : startTime))
            : undefined;
          restoredAgents.set(a.id, {
            id: a.id,
            role: a.role,
            model: a.model,
            status: (isFinished ? (a.status === 'failed' ? 'failed' : 'completed') : 'running') as TrackedAgent['status'],
            toolCalls,
            startTime,
            endTime,
            durationMs: a.durationMs ?? (endTime != null ? endTime - startTime : undefined),
            iterations: a.iteration || cliIterations || undefined,
          });
        }
      } catch {}

      updateSessionState(sessionId, (prev) => {
        // Merge restored agents with live-tracked agents, preserving live
        // data. WebSocket events carry status streaming (Phase 5
        // tool_call_complete: status, durationMs, resultPreview, error)
        // that the REST `/agents/:id/events` endpoint does NOT replay, so
        // blindly overwriting toolCalls on every 10s poll caused live
        // entries to flicker — pop in from WS, get wiped by the next
        // restore, come back on the next tool, vanish again.
        //
        // Rule: live toolCalls win whenever the live list is non-empty
        // OR carries any streamed status field. REST is the cold-load
        // fallback for sessions we don't have live data for yet.
        let mergedAgents = prev.trackedAgents;
        if (restoredAgents.size > 0) {
          mergedAgents = new Map(restoredAgents);
          Array.from(prev.trackedAgents.entries()).forEach(([id, liveAgent]) => {
            const restored = mergedAgents.get(id);
            if (!restored) {
              mergedAgents.set(id, liveAgent);
              return;
            }
            const liveHasToolData =
              liveAgent.toolCalls.length > 0 &&
              (liveAgent.toolCalls.length >= restored.toolCalls.length ||
                liveAgent.toolCalls.some(tc => tc.status || tc.durationMs != null || tc.resultPreview || tc.error));
            mergedAgents.set(id, {
              ...restored,
              // Phase 5: keep live tool-call entries so the streamed
              // status/duration/preview don't get wiped by the poll.
              toolCalls: liveHasToolData ? liveAgent.toolCalls : restored.toolCalls,
              // Live durationMs/endTime can be fresher than the DB row.
              durationMs:
                liveAgent.durationMs && (!restored.durationMs || restored.durationMs === 0)
                  ? liveAgent.durationMs
                  : restored.durationMs,
              endTime: liveAgent.endTime ?? restored.endTime,
            });
          });
        }
        // Merge restored file changes with any live-tracked ones
        const mergedFileChanges = restoredFileChanges.length > 0
          ? [...restoredFileChanges, ...prev.fileChanges.filter(fc =>
              !restoredFileChanges.some(r => r.path === fc.path && r.agentId === fc.agentId)
            )]
          : prev.fileChanges;
        return { ...prev, messages: msgs, trackedAgents: mergedAgents, fileChanges: mergedFileChanges };
      });
    } catch {}
  }, [updateSessionState]);

  // Initialize
  useEffect(() => {
    if (!mounted) {
      setMounted(true);
      const savedActive = localStorage.getItem(STORAGE_KEY_ACTIVE);

      loadSessions().then((items) => {
        if (items.length > 0) {
          const target = savedActive && items.find(t => t.id === savedActive)
            ? savedActive
            : items[0].id;
          setActiveSessionId(target);
          loadSessionMessages(target);
        }
      });

      // Load experts
      api.get<{ experts: Preset[] }>('/experts')
        .then((data) => { if (data?.experts) setPresets(data.experts); })
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  // Persist active session
  useEffect(() => {
    if (activeSessionId) localStorage.setItem(STORAGE_KEY_ACTIVE, activeSessionId);
  }, [activeSessionId]);

  // Refresh sessions when the active workspace changes.
  // Sessions are workspace-scoped via the X-Octipus-Workspace header; without
  // re-loading here the user has to navigate away and back to see the list
  // for the newly selected workspace.
  useEffect(() => {
    if (!mounted) return;
    loadSessions().then((items) => {
      // Clear the active session if it no longer belongs to this workspace
      if (activeSessionId && !items.find(s => s.id === activeSessionId)) {
        setActiveSessionId(items[0]?.id ?? null);
        if (items[0]?.id) loadSessionMessages(items[0].id);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspace?.id]);

  // Check connection + load models
  const checkConnection = useCallback(async () => {
    try {
      const health = await api.get<{ status: string }>('/health');
      if (health?.status === 'ok') setConnectionStatus('connected');
    } catch {
      setConnectionStatus('disconnected');
    }
    try {
      const data = await api.get<{ models: Array<{ name: string; isDefault: boolean }> }>('/models');
      if (data?.models) {
        setModels(data.models);
        const defaultModel = data.models.find(m => m.isDefault);
        if (defaultModel && !selectedModel) setSelectedModel(defaultModel.name);
      }
    } catch {}
  }, [selectedModel]);

  useEffect(() => { checkConnection(); }, [checkConnection]);

  // Poll for new messages (handles telegram/channel sessions that bypass WebSocket)
  useEffect(() => {
    if (!activeSessionId) return;
    const interval = setInterval(() => {
      loadSessionMessages(activeSessionId);
      loadSessions();
    }, 10_000); // Every 10 seconds
    return () => clearInterval(interval);
  }, [activeSessionId, loadSessionMessages, loadSessions]);

  // WebSocket with auto-reconnection
  const reconnectDelay = useRef(1000);

  useEffect(() => {
    if (!mounted) return;

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const connect = async () => {
      if (cancelled) return;

      if (wsInstance && wsInstance.readyState <= WebSocket.OPEN) {
        wsRef.current = wsInstance;
        wsInstance.onmessage = (event) => {
          try { handleWsMessage(JSON.parse(event.data)); } catch {}
        };
        setConnectionStatus(wsInstance.readyState === WebSocket.OPEN ? 'connected' : 'connecting');
        return;
      }

      let ws: WebSocket;
      try {
        ws = await createAuthenticatedWebSocket('/ws');
        if (cancelled) {
          try { ws.close(); } catch { /* ignore */ }
          return;
        }
        wsInstance = ws;
        wsRef.current = ws;
        ws.onopen = () => {
          setConnectionStatus('connected');
          reconnectDelay.current = 1000; // Reset backoff on successful connect
        };
        ws.onmessage = (event) => {
          try { handleWsMessage(JSON.parse(event.data)); } catch {}
        };
        ws.onclose = (event) => {
          if (event.code === 4000) return; // Superseded by new connection
          if (cancelled) return;
          if (wsInstance === ws) {
            setConnectionStatus('disconnected');
            wsRef.current = null;
            wsInstance = null;
            // Auto-reconnect with exponential backoff (max 30s)
            reconnectTimer = setTimeout(() => {
              reconnectDelay.current = Math.min(reconnectDelay.current * 1.5, 30000);
              connect();
            }, reconnectDelay.current);
          }
        };
        ws.onerror = () => {
          if (wsInstance === ws) setConnectionStatus('disconnected');
        };
      } catch {
        setConnectionStatus('disconnected');
        if (!cancelled) {
          reconnectTimer = setTimeout(connect, reconnectDelay.current);
        }
      }
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  // WebSocket keepalive ping every 30s to prevent idle disconnection
  useEffect(() => {
    if (!mounted) return;
    const interval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, [mounted]);

  const handleWsMessage = (data: any) => {
    const eventSessionId = data.sessionId;

    switch (data.type) {
      case 'connected':
        setConnectionStatus('connected');
        break;

      case 'chat_response': {
        setIsLoading(false);
        setStatusMessage(null);
        const meta: MessageMetadata | undefined = data.metadata ? {
          model: data.metadata.model,
          tokens: data.metadata.tokens,
          latencyMs: data.metadata.latencyMs,
          cached: data.metadata.cached,
        } : undefined;

        const sid = data.sessionId || activeSessionId;
        // `/clear` returns the literal "[clear]" sentinel for webchat clients.
        // Wipe the visible message list and tracked agents/teams instead of
        // appending "[clear]" as an assistant message. The orchestrator side
        // has already recorded clearedAt on the session so future replies
        // ignore pre-clear history.
        if (sid && typeof data.response === 'string' && data.response.trim() === '[clear]') {
          updateSessionState(sid, () => ({
            messages: [
              welcomeMessage(),
              {
                id: Date.now().toString(),
                role: 'system',
                content: 'Session context cleared. Send a new message to start fresh.',
                timestamp: new Date(),
              },
            ],
            trackedAgents: new Map(),
            teams: new Map(),
            totalTokens: 0,
            swarmDurationMs: 0,
            fileChanges: [],
          }));
          break;
        }
        if (sid) {
          updateSessionState(sid, (prev) => {
            // Finalize any agents still marked as 'running'.
            // If the response indicates the task was stopped/aborted, mark as 'stopped'.
            const responseText = typeof data.content === 'string' ? data.content : '';
            const wasStopped = responseText.includes('stopped') || responseText.includes('aborted');
            const finalStatus = wasStopped ? 'stopped' : 'completed';
            const now = Date.now();
            const next = new Map(prev.trackedAgents);
            Array.from(next.entries()).forEach(([id, agent]) => {
              if (agent.status === 'running') {
                const elapsed = now - agent.startTime;
                next.set(id, {
                  ...agent,
                  status: finalStatus,
                  endTime: agent.endTime ?? now,
                  // Keep existing durationMs if already set by worker_completed
                  durationMs: agent.durationMs || elapsed,
                });
              }
            });
            return {
              ...prev,
              trackedAgents: next,
              messages: [...prev.messages, {
                id: Date.now().toString(),
                role: 'assistant',
                content: data.response,
                timestamp: new Date(),
                agentId: data.agentId,
                classification: data.classification?.type,
                metadata: meta,
              }],
              totalTokens: data.metadata?.sessionTotalTokens != null
                ? data.metadata.sessionTotalTokens
                : prev.totalTokens + (meta?.tokens || 0),
            };
          });

          if (data.sessionId) {
            setSessions(prev => {
              if (prev.find(s => s.id === data.sessionId)) return prev;
              return [{ id: data.sessionId, title: 'New Chat', updatedAt: new Date().toISOString(), messageCount: 0, tokenCount: 0, status: 'active' }, ...prev];
            });
            if (!activeSessionId) setActiveSessionId(data.sessionId);
          }
        }
        break;
      }

      case 'chat_error':
        setIsLoading(false);
        setStatusMessage(null);
        if (eventSessionId || activeSessionId) {
          const sid = eventSessionId || activeSessionId!;
          updateSessionState(sid, (prev) => ({
            ...prev,
            messages: [...prev.messages, {
              id: Date.now().toString(),
              role: 'assistant',
              content: `Error: ${data.error}`,
              timestamp: new Date(),
            }],
          }));
        }
        break;

      case 'orchestrator_event':
        handleOrchestratorEvent(data, eventSessionId || activeSessionId);
        break;

      case 'agent_event':
        handleAgentEvent(data, eventSessionId || activeSessionId);
        break;

      case 'permission_request':
        // Forward to global permission context for banner display
        pushPermission({
          requestId: data.requestId,
          skillId: data.skillId,
          action: data.action || data.toolName,
          args: data.args,
        });
        break;

      case 'swarm_event':
        // Persona narration: render as inline chat bubble so the orchestrator
        // appears to "speak" while subagents work. Without this the bridge
        // emits but no surface displays it, which manifests as "narration
        // never fires" in the UI.
        if (data.event === 'swarm.narration') {
          const np = data.payload as { text?: string };
          const text = (np?.text ?? '').trim();
          const sid = eventSessionId || activeSessionId;
          if (text && sid) {
            if (!activeSessionId) setActiveSessionId(sid);
            pushTransientNarration(sid, text, new Date(data.timestamp ?? Date.now()));
          }
          break;
        }

        // Swarm lifecycle events — funnel into the SwarmTree component AND
        // into the per-session trackedAgents map so the sidepanel's agent
        // count / duration / iteration / token columns populate live.
        // Previously only `worker_spawned` (orchestrator → pipeline worker
        // path) touched trackedAgents, so swarm-spawned children were
        // invisible to the sidepanel until a page reload re-hydrated the
        // agent log from REST.
        if (
          typeof data.event === 'string' &&
          (data.event === 'swarm.node_spawned' || data.event === 'swarm.node_completed')
        ) {
          // First spawn often arrives BEFORE chat_response, when activeSessionId
          // is still null. SwarmTree keys off activeSessionId — without
          // adopting the event's session id now, the live tree stays empty
          // until the user reloads the page. Adopt it eagerly here.
          if (eventSessionId && !activeSessionId) {
            setActiveSessionId(eventSessionId);
          }
          setSwarmEvents((prev) => {
            const next = prev.concat({
              type: data.event,
              payload: data.payload,
            } as SwarmTreeEvent);
            // Cap so a long-running session doesn't grow the array forever.
            // SwarmTree tracks its consumed index relative to length, so we
            // only trim when well past anything still relevant.
            return next.length > 1000 ? next.slice(-500) : next;
          });

          const p = data.payload as {
            nodeId: string;
            parentNodeId?: string | null;
            kind?: 'orchestrator' | 'agent' | 'subagent';
            role?: string;
            model?: string;
            status?: string;
            usedTokens?: number;
            durationMs?: number;
          };
          // Use client-receipt time (Date.now()) — not the server-stamped
          // `data.timestamp` — for agent `startTime`. User messages are
          // stamped with the client clock, so mixing in a server clock
          // (even with small skew) lets agents sort *before* the message
          // that triggered them. Clamping to the latest user message
          // timestamp adds a belt-and-suspenders guarantee.
          const clientNow = Date.now();

          if (data.event === 'swarm.node_spawned' && eventSessionId && p.kind !== 'orchestrator') {
            updateSessionState(eventSessionId, (prev) => {
              const next = new Map(prev.trackedAgents);
              const existing = next.get(p.nodeId);
              const minStart = latestUserMessageTime(prev.messages) + 1;
              next.set(p.nodeId, {
                id: p.nodeId,
                role: p.role || existing?.role || 'unknown',
                model: p.model || existing?.model || '',
                status: 'running',
                toolCalls: existing?.toolCalls ?? [],
                startTime: existing?.startTime ?? Math.max(clientNow, minStart),
                parentAgentId: p.parentNodeId ?? existing?.parentAgentId,
              });
              return { ...prev, trackedAgents: next };
            });
          }

          if (data.event === 'swarm.node_completed' && eventSessionId) {
            const tokens = typeof p.usedTokens === 'number' ? p.usedTokens : 0;
            const duration = typeof p.durationMs === 'number' ? p.durationMs : 0;
            // Session-level aggregates — drive Session Stats badges.
            updateSessionState(eventSessionId, (prev) => {
              const nextAgents = new Map(prev.trackedAgents);
              // Only finalize non-orchestrator nodes in the sidepanel agent
              // list. The orchestrator is not a tracked agent card.
              if (p.kind !== 'orchestrator') {
                const existing = nextAgents.get(p.nodeId);
                const resolvedStatus: TrackedAgent['status'] =
                  p.status === 'completed' || p.status === 'cache_hit'
                    ? 'completed'
                    : p.status === 'cancelled' || p.status === 'stopped'
                      ? 'stopped'
                      : 'failed';
                const minStart = latestUserMessageTime(prev.messages) + 1;
                const fallbackStart = Math.max(clientNow - duration, minStart);
                const startTime = existing?.startTime ?? fallbackStart;
                nextAgents.set(p.nodeId, {
                  id: p.nodeId,
                  role: p.role || existing?.role || 'unknown',
                  model: p.model || existing?.model || '',
                  status: resolvedStatus,
                  toolCalls: existing?.toolCalls ?? [],
                  startTime,
                  endTime: startTime + duration,
                  durationMs: duration,
                  totalTokens: tokens,
                  iterations: existing?.iterations,
                  parentAgentId: p.parentNodeId ?? existing?.parentAgentId,
                });
              }
              // Swarm duration represents wall-clock time of each swarm
              // (the orchestrator's runtime). Sub-agent durations should NOT
              // be added — those are nested inside the orchestrator's time.
              // Total across multiple swarms in a session = sum of each
              // orchestrator's duration.
              const swarmDurationDelta = p.kind === 'orchestrator' ? duration : 0;
              return {
                ...prev,
                trackedAgents: nextAgents,
                totalTokens: (prev.totalTokens || 0) + tokens,
                swarmDurationMs: (prev.swarmDurationMs || 0) + swarmDurationDelta,
              };
            });
          }
        }
        break;

    }
  };

  const handleOrchestratorEvent = (data: any, sessionId: string | null) => {
    if (!sessionId) return;

    switch (data.event) {
      case 'status_update':
        setStatusMessage((data.data as any)?.message || null);
        break;

      case 'approval_required':
        // Forward to global permission context for banner display
        pushApproval({
          requestId: (data.data as any).requestId,
          summary: (data.data as any).summary,
          question: (data.data as any).question,
          options: (data.data as any).options,
        });
        break;

      case 'pipeline_event': {
        const pe = data.data as any;
        switch (pe.event) {
          case 'pipeline_created':
            setStatusMessage(`Pipeline "${pe.title}" started (${pe.stageCount} stages)`);
            break;
          case 'stage_started': {
            const stageNum = (pe.index ?? 0) + 1;
            setStatusMessage(`Stage ${stageNum}: ${pe.name}...`);
            // Stage messages are persisted to DB by the backend — reload to pick them up
            if (sessionId) loadSessionMessages(sessionId);
            break;
          }
          case 'stage_completed': {
            const note = pe.note ? ` (${pe.note})` : '';
            setStatusMessage(`Stage "${pe.name}" completed${note}`);
            // Stage messages are persisted to DB by the backend — reload to pick them up
            if (sessionId) loadSessionMessages(sessionId);
            break;
          }
          case 'qa_retry': {
            setStatusMessage(`QA found issues — retrying implementation (attempt ${pe.attempt}/${pe.maxRetries})`);
            break;
          }
          case 'pipeline_completed':
            setStatusMessage(null);
            break;
        }
        break;
      }

      case 'worker_spawned': {
        const d = data.data as any;
        const agentId = d.workerId || d.agentId;
        // Use client-receipt time, clamped to be after the latest user
        // message, so the worker indicator can't sort before the message
        // that triggered it due to clock skew.
        const clientNow = Date.now();
        updateSessionState(sessionId, (prev) => {
          const next = new Map(prev.trackedAgents);
          const minStart = latestUserMessageTime(prev.messages) + 1;
          next.set(agentId, {
            id: agentId,
            role: d.role,
            model: d.model,
            status: 'running',
            toolCalls: [],
            startTime: Math.max(clientNow, minStart),
            parentAgentId: d.parentAgentId,
            stageName: d.stageName,
          });
          return { ...prev, trackedAgents: next };
        });
        break;
      }

      case 'worker_completed': {
        const d = data.data as any;
        const agentId = d.workerId;
        const workerStatus = d.status === 'failed' ? 'failed' : d.status === 'stopped' ? 'stopped' : 'completed';
        updateSessionState(sessionId, (prev) => {
          const next = new Map(prev.trackedAgents);
          const existing = next.get(agentId);
          if (existing) {
            // Use server-reported durationMs to compute endTime so it freezes accurately
            const serverDuration = typeof d.durationMs === 'number' ? d.durationMs : undefined;
            const endTime = serverDuration != null
              ? existing.startTime + serverDuration
              : Date.now();
            next.set(agentId, {
              ...existing,
              status: workerStatus,
              endTime,
              durationMs: serverDuration ?? (Date.now() - existing.startTime),
              totalTokens: d.totalTokens,
              iterations: d.iterations,
              error: d.error,
            });
          } else {
            // Agent wasn't tracked via worker_spawned (race condition or missed event)
            // Create a completed entry so the duration is still visible.
            // Use client time clamped to last user message to keep ordering sane.
            const now = Date.now();
            const minStart = latestUserMessageTime(prev.messages) + 1;
            const startTime = d.durationMs
              ? Math.max(now - d.durationMs, minStart)
              : Math.max(now, minStart);
            next.set(agentId, {
              id: agentId,
              role: d.role || 'unknown',
              model: d.model || '',
              status: workerStatus,
              toolCalls: [],
              startTime,
              endTime: Math.max(now, startTime),
              durationMs: d.durationMs ?? 0,
              totalTokens: d.totalTokens,
              iterations: d.iterations,
              error: d.error,
            });
          }
          return {
            ...prev,
            trackedAgents: next,
            totalTokens: d.totalTokens ? prev.totalTokens + d.totalTokens : prev.totalTokens,
          };
        });
        break;
      }

      case 'team_started': {
        const d = data.data as any;
        updateSessionState(sessionId, (prev) => {
          const next = new Map(prev.teams);
          next.set(d.teamId, { id: d.teamId, memberIds: [], status: 'running' });
          return { ...prev, teams: next };
        });
        break;
      }

      case 'team_completed': {
        const d = data.data as any;
        updateSessionState(sessionId, (prev) => {
          const next = new Map(prev.teams);
          const existing = next.get(d.teamId);
          if (existing) {
            next.set(d.teamId, { ...existing, status: 'completed', durationMs: d.durationMs });
          }
          return { ...prev, teams: next };
        });
        break;
      }
    }
  };

  const handleAgentEvent = (data: any, sessionId: string | null) => {
    if (!sessionId) return;
    if (data.event === 'action' && data.agentId) {
      const d = data.data as any;

      // Standard agent tool calls (array format)
      if (d?.toolCalls) {
        const toolCalls: ToolCallInfo[] = d.toolCalls.map((tc: any) => ({
          id: tc.id || Date.now().toString(),
          name: tc.name,
          argsSummary: tc.argsSummary,
        }));
        // File-change entries come from the dedicated `file_change` event
        // emitted by `tool-executor.ts` after a successful filesystem write.
        // Don't try to derive them from `argsSummary` here — the summary is
        // truncated to 120 chars with ", "-separated fields, so paths
        // containing spaces (e.g. "C:/Users/patri/Github Reps/…") get cut
        // off at the first space, which produced a phantom duplicate entry
        // like "C:/Users/patri/Github" sitting next to the real path.
        let agentRoleForNarration = 'unknown';
        updateSessionState(sessionId, (prev) => {
          const next = new Map(prev.trackedAgents);
          const existing = next.get(data.agentId);
          if (existing) {
            agentRoleForNarration = existing.role;
            next.set(data.agentId, {
              ...existing,
              toolCalls: [...existing.toolCalls, ...toolCalls],
            });
          }
          return { ...prev, trackedAgents: next };
        });
        // Per-tool transient narration — fades in, fades out. Lets the
        // user see *what* the agent is doing as it runs without filling
        // the chat with a persistent tool log. argsSummary already gets
        // truncated to 120 chars upstream so the bubble stays compact.
        for (const tc of toolCalls) {
          const argsPart = tc.argsSummary ? ` · ${tc.argsSummary}` : '';
          pushTransientNarration(
            sessionId,
            `${agentRoleForNarration} arm calls \`${tc.name}\`${argsPart}`,
          );
        }
      }
      // CLI agent tool use (single tool format from cli_tool_use events)
      else if (d?.type === 'cli_tool_use' && d?.toolName) {
        updateSessionState(sessionId, (prev) => {
          const next = new Map(prev.trackedAgents);
          const existing = next.get(data.agentId);
          if (existing) {
            // Increment iteration count for CLI agents
            next.set(data.agentId, {
              ...existing,
              iterations: (existing.iterations || 0) + 1,
              toolCalls: [...existing.toolCalls, {
                id: Date.now().toString(),
                name: String(d.toolName),
                argsSummary: d.args ? JSON.stringify(d.args).slice(0, 80) : undefined,
              }],
            });
          }
          // Track file changes from CLI agents
          const CLI_FILE_TOOL_MAP: Record<string, string> = {
            // Claude Code
            'Write': 'write',
            'Edit': 'edit',
            // Gemini CLI
            'replace_file': 'edit',
            'write_file': 'write',
            'create_file': 'write',
            'delete_file': 'delete',
            'patch_file': 'edit',
            'update_file': 'edit',
            // Generic
            'write': 'write',
            'edit': 'edit',
            'replace': 'edit',
            'create': 'write',
            'delete': 'delete',
          };
          const toolName = String(d.toolName);
          const fileAction = CLI_FILE_TOOL_MAP[toolName];
          if (fileAction && d.args) {
            const filePath = d.args.file_path || d.args.path || d.args.filename || d.args.target || '';
            if (filePath) {
              return {
                ...prev,
                trackedAgents: next,
                fileChanges: [...prev.fileChanges, {
                  path: String(filePath),
                  action: fileAction,
                  agentId: data.agentId,
                  agentRole: existing?.role || 'unknown',
                  timestamp: new Date().toISOString(),
                }],
              };
            }
          }
          return { ...prev, trackedAgents: next };
        });
      }
      // Phase 5: per-tool completion event — flip the tracked tool call
      // entry's status the moment the tool returns so the user sees live
      // progress instead of all tools turning "done" at end-of-batch.
      // If the event arrives before the matching `action` event (rare:
      // React batching could in theory reorder setState commits),
      // synthesize a placeholder so the completion isn't lost.
      else if (d?.type === 'tool_call_complete' && d?.toolCallId) {
        // Emit a transient completion narration so the user sees the
        // outcome ("data arm · read_file · 0.2s" or "data arm · bash
        // failed: timeout"). Counterpart to the start narration above.
        const completionRole = (() => {
          const state = sessionStates.get(sessionId);
          return state?.trackedAgents.get(data.agentId)?.role ?? 'unknown';
        })();
        const toolName = typeof d.name === 'string' ? d.name : '';
        const status = String(d.status ?? 'ok');
        const dur = typeof d.durationMs === 'number'
          ? ` · ${(d.durationMs / 1000).toFixed(d.durationMs >= 1000 ? 1 : 2)}s`
          : '';
        const err = typeof d.error === 'string' ? d.error : null;
        if (toolName) {
          if (status === 'error' && err) {
            pushTransientNarration(sessionId, `${completionRole} arm · \`${toolName}\` failed: ${err}`);
          } else if (status === 'cancelled') {
            pushTransientNarration(sessionId, `${completionRole} arm · \`${toolName}\` cancelled`);
          } else {
            pushTransientNarration(sessionId, `${completionRole} arm · \`${toolName}\`${dur}`);
          }
        }
        updateSessionState(sessionId, (prev) => {
          const next = new Map(prev.trackedAgents);
          const existing = next.get(data.agentId);
          const completionPatch = {
            status: String(d.status ?? 'ok'),
            durationMs: typeof d.durationMs === 'number' ? d.durationMs : undefined,
            resultPreview: typeof d.resultPreview === 'string' ? d.resultPreview : undefined,
            error: typeof d.error === 'string' ? d.error : undefined,
          };
          if (!existing) {
            // Agent record not yet hydrated — stash the completion on a
            // stub so the eventual `action`/`swarm.node_spawned` arrival
            // can merge it. Stubs are harmless if abandoned.
            next.set(data.agentId, {
              id: data.agentId,
              role: 'unknown',
              model: '',
              status: 'running',
              toolCalls: [{
                id: String(d.toolCallId),
                name: typeof d.name === 'string' ? d.name : '',
                ...completionPatch,
              }],
              startTime: Date.now(),
            });
            return { ...prev, trackedAgents: next };
          }
          let matched = false;
          const updatedCalls = existing.toolCalls.map(tc => {
            if (tc.id === d.toolCallId) {
              matched = true;
              return { ...tc, ...completionPatch };
            }
            return tc;
          });
          // Completion came before the start emit landed in this map —
          // append a partial entry so we still surface the status.
          if (!matched) {
            updatedCalls.push({
              id: String(d.toolCallId),
              name: typeof d.name === 'string' ? d.name : '',
              ...completionPatch,
            });
          }
          next.set(data.agentId, { ...existing, toolCalls: updatedCalls });
          return { ...prev, trackedAgents: next };
        });
      }
      // File change events from built-in filesystem tools
      else if (d?.type === 'file_change' && d?.path) {
        updateSessionState(sessionId, (prev) => ({
          ...prev,
          fileChanges: [...prev.fileChanges, {
            path: String(d.path),
            action: String(d.action || 'write'),
            agentId: data.agentId,
            agentRole: String(d.agentRole || 'unknown'),
            timestamp: new Date().toISOString(),
            content: d.content as string | undefined,
            oldContent: d.oldContent as string | undefined,
          }],
        }));
      }
    }
  };

  // Session management
  const createSession = () => {
    setShowNewSessionDialog(true);
  };

  const handleCreateSession = async (opts: NewSessionOptions) => {
    setShowNewSessionDialog(false);
    try {
      const title = opts.devMode ? `Dev: ${opts.projectName || 'project'}` : 'New Chat';
      const context = opts.devMode
        ? { devMode: true, projectPath: opts.projectPath, projectName: opts.projectName }
        : {};

      const result = await api.post<{ id: string; title: string; updatedAt: string; messageCount: number; status: string }>('/sessions', {
        channelType: 'webchat',
        channelId: `chat-${Date.now().toString(36)}`,
        title,
        context,
      });
      if (result?.id) {
        const item: SessionInfo = {
          id: result.id,
          title: result.title || title,
          updatedAt: result.updatedAt || new Date().toISOString(),
          messageCount: 0,
          tokenCount: 0,
          status: 'active',
          devMode: opts.devMode,
          projectName: opts.projectName,
        };
        setSessions(prev => [item, ...prev]);
        setActiveSessionId(item.id);
        updateSessionState(item.id, () => newSessionState());
        setIsLoading(false);
        setStatusMessage(null);
      }
    } catch (error) {
      console.error('Failed to create session:', error);
    }
  };

  const selectSession = (id: string) => {
    if (id === activeSessionId) return;
    setActiveSessionId(id);
    loadSessionMessages(id);
    setIsLoading(false);
    setStatusMessage(null);

    if (!sessionStates.has(id)) {
      updateSessionState(id, () => newSessionState());
      loadSessionMessages(id);
    }
  };

  const deleteSession = async (id: string) => {
    // Track locally so polling doesn't resurrect the session
    deletedSessionsRef.current.add(id);

    try {
      await api.delete(`/sessions/${id}`);
    } catch (err) {
      console.error('Failed to delete session:', err);
    }

    setSessions(prev => prev.filter(s => s.id !== id));
    setSessionStates(prev => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });

    if (activeSessionId === id) {
      const remaining = sessions.filter(s => s.id !== id);
      if (remaining.length > 0) selectSession(remaining[0].id);
      else setActiveSessionId(null);
    }
  };

  const renameSession = async (id: string, title: string) => {
    try {
      await api.patch(`/sessions/${id}`, { title });
      setSessions(prev => prev.map(s => s.id === id ? { ...s, title } : s));
    } catch {}
  };

  // Send message
  const sendMessage = async (userInput: string, attachments?: Attachment[]) => {
    let sid = activeSessionId;

    // Auto-create a session if none is active
    if (!sid) {
      try {
        const result = await api.post<{ id: string; title: string; updatedAt: string; messageCount: number; status: string }>('/sessions', {
          channelType: 'webchat',
          channelId: `chat-${Date.now().toString(36)}`,
          title: userInput.slice(0, 100) || 'New Chat',
        });
        if (result?.id) {
          sid = result.id;
          const item: SessionInfo = {
            id: result.id,
            title: result.title || 'New Chat',
            updatedAt: result.updatedAt || new Date().toISOString(),
            messageCount: 0,
            tokenCount: 0,
            status: 'active',
          };
          setSessions(prev => [item, ...prev]);
          setActiveSessionId(sid);
          updateSessionState(sid, () => newSessionState());
        }
      } catch (error) {
        console.error('Failed to create session:', error);
        return;
      }
    }

    if (!sid) return; // Should not happen — session creation above handles this

    const userMessage: ChatMessageData = {
      id: Date.now().toString(),
      role: 'user',
      content: userInput,
      timestamp: new Date(),
    };

    updateSessionState(sid, (prev) => ({
      ...prev,
      messages: [...prev.messages, userMessage],
      // Keep trackedAgents/teams from prior turns visible — they're part of
      // this session's history. Clearing them here caused a vanish/restore
      // flicker when the 10s poll later re-hydrated them from the DB.
    }));

    setIsLoading(true);

    // WS is the primary transport. If it's OPEN → send.
    // If it's CONNECTING → wait up to 5 s for open, then send. This avoids a
    // race where we fall back to REST mid-connect, fire a 30 s+ orchestrator
    // request against a proxy with a shorter timeout, and see a transient
    // "Request failed" pop up while the real answer is still streaming in
    // via the WS that finally opened.
    const ws = wsRef.current;
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
      const sendOverWs = () => {
        ws.send(JSON.stringify({
          type: 'chat',
          content: userInput,
          sessionId: sid,
          expertId: selectedPresetId || undefined,
        }));
      };
      if (ws.readyState === WebSocket.OPEN) {
        sendOverWs();
        return;
      }
      // CONNECTING — wait for open (bounded). Bumped from 5s to 10s after
      // observing race conditions where WS reconnect took 6–8s on a slow
      // network, the wait timed out, REST took over, and a transient
      // "Request failed" appeared while the real answer streamed in via the
      // WS that finally opened. The post-REST WS-alive check below
      // additionally suppresses the toast if WS came back during the REST
      // request itself.
      const opened = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 10_000);
        const onOpen = () => { clearTimeout(timer); ws.removeEventListener('open', onOpen); resolve(true); };
        ws.addEventListener('open', onOpen, { once: true });
      });
      const state: number = ws.readyState;
      if (opened && state === WebSocket.OPEN) {
        sendOverWs();
        return;
      }
      // fall through to REST only if WS never opened
    }

    // REST fallback (WS unavailable)
    try {
      const result = await api.post<{
        response: string;
        sessionId: string;
        agentId?: string;
        classification?: { type: string };
        metadata?: MessageMetadata;
      }>('/chat', { message: userInput, sessionId: sid, expertId: selectedPresetId || undefined });

      const responseSid = result.sessionId || sid;
      if (responseSid) {
        updateSessionState(responseSid, (prev) => ({
          ...prev,
          messages: [...prev.messages, {
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: result.response,
            timestamp: new Date(),
            agentId: result.agentId,
            classification: result.classification?.type,
            metadata: result.metadata,
          }],
        }));

        if (result.sessionId && !activeSessionId) {
          setActiveSessionId(result.sessionId);
          setSessions(prev => {
            if (prev.find(s => s.id === result.sessionId)) return prev;
            return [{ id: result.sessionId, title: 'New Chat', updatedAt: new Date().toISOString(), messageCount: 0, tokenCount: 0, status: 'active' }, ...prev];
          });
        }
      }
    } catch (error) {
      // The REST `/chat` request often races a reconnecting WebSocket. If the
      // WS came back online between our `sendMessage()` entry and the REST
      // failure, the agent is already running and will deliver its answer via
      // WS — surfacing a scary "backend is running?" toast in that case just
      // confuses the user.
      //
      // Two-stage suppression:
      //   1. Wait up to 2500ms for the WS to reconnect (initial backoff is
      //      1000ms, handshake adds ~200–500ms, plus slack for slow networks).
      //   2. If WS still hasn't recovered, probe /health. A 200 means the
      //      backend is reachable and the REST failure was a transient
      //      proxy/timeout issue — the WS will deliver the real answer when
      //      it reconnects, so swallow the toast.
      const wsAlive = await new Promise<boolean>((resolve) => {
        const startedAt = Date.now();
        const tick = () => {
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) return resolve(true);
          if (Date.now() - startedAt >= 2500) return resolve(false);
          setTimeout(tick, 50);
        };
        tick();
      });

      let backendReachable = wsAlive;
      if (!backendReachable) {
        try {
          const res = await fetch(`${getApiUrl()}/health`, {
            method: 'GET',
            signal: AbortSignal.timeout(1500),
          });
          backendReachable = res.ok;
        } catch {
          backendReachable = false;
        }
      }

      if (sid && !backendReachable) {
        updateSessionState(sid, (prev) => ({
          ...prev,
          messages: [...prev.messages, {
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: `Error: ${(error as Error).message}. Make sure Octipus backend is running.`,
            timestamp: new Date(),
          }],
        }));
      }
    }

    setIsLoading(false);
    setStatusMessage(null);
  };

  return (
    <div className="h-full flex">
      {/* New session dialog */}
      <NewSessionDialog
        open={showNewSessionDialog}
        onClose={() => setShowNewSessionDialog(false)}
        onCreate={handleCreateSession}
      />

      {/* Left panel — Session list */}
      <div className="w-64 border-r border-outline-variant/10 shrink-0 bg-surface-container-low">
        <SessionList
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelect={selectSession}
          onCreate={createSession}
          onDelete={deleteSession}
          onRename={renameSession}
        />
      </div>

      {/* Center — Messages + Input */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Message timeline */}
        <MessageTimeline
          messages={messages}
          trackedAgents={trackedAgents}
          teams={teams}
          fileChanges={activeState?.fileChanges}
          isLoading={isLoading}
          statusMessage={statusMessage}
        />

        {/* Prompt input */}
        <div className="border-t border-outline-variant/10 bg-surface-container p-3">
          <PromptInput
            onSend={sendMessage}
            disabled={isLoading}
            placeholder={activeSessionId ? 'Send a message...' : 'Create a session to start chatting'}
          />
        </div>
      </div>

      {/* Right panel — single SidePanel containing: Connection & Model →
          Session Stats → Swarm Tree. Agent Activity was removed; SwarmTree
          replaces it as the canonical live view. */}
      {showSidePanel && (
        <div className="w-72 border-l border-outline-variant/10 shrink-0 bg-surface-container flex flex-col overflow-y-auto">
          <SidePanel
            totalTokens={sessionTotalTokens}
            maxTokenBudget={maxTokenBudget}
            trackedAgents={trackedAgents}
            teams={teams}
            connectionStatus={connectionStatus}
            selectedModel={selectedModel}
            models={models}
            onModelChange={setSelectedModel}
            selectedPresetId={selectedPresetId}
            presets={presets}
            onPresetChange={setSelectedPresetId}
            swarmSessionId={activeSessionId}
            swarmEvents={swarmEvents}
            swarmDurationMs={swarmDurationMs}
            onSwarmHydratedTotals={(totals) => {
              if (!activeSessionId) return;
              // Seed session totals on cold reload: prefer the hydrated sum
              // (authoritative historical state) over whatever in-memory
              // counter happened to survive page navigation.
              updateSessionState(activeSessionId, (prev) => ({
                ...prev,
                totalTokens: totals.tokens,
                swarmDurationMs: totals.durationMs,
              }));
            }}
          />
        </div>
      )}

      {/* Side panel toggle */}
      <button
        onClick={() => setShowSidePanel(!showSidePanel)}
        className="absolute top-20 right-2 p-1.5 rounded-lg bg-surface-container-highest shadow-xs ring-1 ring-outline-variant/10 text-on-surface-variant hover:text-on-surface z-10 cursor-pointer"
        title={showSidePanel ? 'Hide panel' : 'Show panel'}
      >
        {showSidePanel ? <PanelRightClose className="w-4 h-4" /> : <PanelRight className="w-4 h-4" />}
      </button>
    </div>
  );
}
