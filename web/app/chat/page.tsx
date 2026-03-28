'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Loader2, Bot, CheckCircle, XCircle, PanelRightClose, PanelRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api, createWebSocket } from '@/lib/api';
import MessageTimeline, {
  type ChatMessageData,
  type MessageMetadata,
  type TrackedAgent,
  type TeamState,
} from '@/components/chat/message-timeline';
import { SessionList, type SessionInfo } from '@/components/chat/session-list';
import SidePanel from '@/components/chat/side-panel';
import PromptInput, { type Attachment } from '@/components/chat/prompt-input';
import { NewSessionDialog, type NewSessionOptions } from '@/components/chat/new-session-dialog';

interface ApprovalRequest {
  requestId: string;
  summary: string;
  question: string;
  options?: string[];
}

interface PermissionRequest {
  requestId: string;
  skillId: string;
  action: string;
  args?: Record<string, unknown>;
}

interface ToolCallInfo {
  id: string;
  name: string;
  argsSummary?: string;
}

export interface FileChange {
  path: string;
  action: string;
  agentId: string;
  agentRole: string;
  timestamp: string;
}

// Per-session state
interface SessionState {
  messages: ChatMessageData[];
  trackedAgents: Map<string, TrackedAgent>;
  teams: Map<string, TeamState>;
  totalTokens: number;
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
    fileChanges: [],
  };
}

interface Preset {
  id: string;
  name: string;
  description?: string;
  role: string;
}

export default function ChatPage() {
  const [mounted, setMounted] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const deletedSessionsRef = useRef<Set<string>>(new Set());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionStates, setSessionStates] = useState<Map<string, SessionState>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'connecting'>('connecting');
  const [models, setModels] = useState<Array<{ name: string; isDefault: boolean }>>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [showSidePanel, setShowSidePanel] = useState(true);
  const [showNewSessionDialog, setShowNewSessionDialog] = useState(false);
  const [maxTokenBudget, setMaxTokenBudget] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);

  // Active session state
  const activeState = activeSessionId ? sessionStates.get(activeSessionId) : null;
  const messages = activeState?.messages || [welcomeMessage()];
  const trackedAgents = activeState?.trackedAgents || new Map();
  const teams = activeState?.teams || new Map();
  const sessionTotalTokens = activeState?.totalTokens || 0;

  // Update a session's state
  const updateSessionState = useCallback((sessionId: string, updater: (prev: SessionState) => SessionState) => {
    setSessionStates(prev => {
      const next = new Map(prev);
      const current = next.get(sessionId) || newSessionState();
      next.set(sessionId, updater(current));
      return next;
    });
  }, []);

  // Load sessions from backend
  const loadSessions = useCallback(async () => {
    try {
      const data = await api.get<{ sessions: Array<{ id: string; title: string; updatedAt: string; messageCount: number; tokenCount?: number; status: string; channelType?: string; context?: { devMode?: boolean; projectName?: string } }>; maxTokenBudget?: number }>('/sessions');
      if (data?.maxTokenBudget != null) setMaxTokenBudget(data.maxTokenBudget);
      if (data?.sessions?.length) {
        const items: SessionInfo[] = data.sessions
          .filter(s => s.status === 'active' && (!s.channelType || s.channelType === 'webchat' || s.channelType === 'api'))
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
        `/sessions/${sessionId}/messages?roles=user,assistant,system`
      );
      const msgs = data?.messages?.length
        ? data.messages.map((m) => ({
            id: m.id,
            role: m.role as ChatMessageData['role'],
            content: m.content,
            timestamp: new Date(m.createdAt),
          }))
        : [welcomeMessage()];

      // Restore agent activity for this session
      let restoredAgents = new Map<string, TrackedAgent>();
      try {
        const agentData = await api.get<{ agents: Array<{ id: string; sessionId: string; role: string; model: string; status: string; createdAt: string; completedAt?: string; durationMs?: number; iteration: number }> }>('/agents');
        const sessionAgents = (agentData?.agents || []).filter(a => a.sessionId === sessionId);
        for (const a of sessionAgents) {
          let toolCalls: Array<{ id: string; name: string; argsSummary?: string }> = [];
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
        // Merge restored agents with live-tracked agents, preserving live data
        // (WebSocket events have accurate durationMs before DB persists it)
        let mergedAgents = prev.trackedAgents;
        if (restoredAgents.size > 0) {
          mergedAgents = new Map(restoredAgents);
          // Preserve live-tracked data that may be more accurate
          Array.from(prev.trackedAgents.entries()).forEach(([id, liveAgent]) => {
            const restored = mergedAgents.get(id);
            if (restored && liveAgent.durationMs && (!restored.durationMs || restored.durationMs === 0)) {
              mergedAgents.set(id, { ...restored, durationMs: liveAgent.durationMs, endTime: liveAgent.endTime });
            } else if (!restored) {
              mergedAgents.set(id, liveAgent);
            }
          });
        }
        return { ...prev, messages: msgs, trackedAgents: mergedAgents };
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

  // Check for pending approvals (polling fallback when WebSocket reconnects or events are missed)
  const checkPendingApprovals = useCallback(async () => {
    try {
      const res = await api.get<{ approvals: ApprovalRequest[] }>('/chat/approvals/pending');
      if (res?.approvals?.length > 0 && !pendingApproval) {
        const a = res.approvals[0];
        setPendingApproval({
          requestId: a.requestId,
          summary: a.summary,
          question: a.question,
          options: a.options,
        });
      }
    } catch { /* ignore */ }
  }, [pendingApproval]);

  // WebSocket with auto-reconnection
  const reconnectDelay = useRef(1000);

  useEffect(() => {
    if (!mounted) return;
    const token = api.getToken();
    if (!token) return;

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const connect = () => {
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
        ws = createWebSocket('/ws');
        wsInstance = ws;
        wsRef.current = ws;
        ws.onopen = () => {
          setConnectionStatus('connected');
          reconnectDelay.current = 1000; // Reset backoff on successful connect
          // Check for any approvals that arrived while disconnected
          checkPendingApprovals();
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

  // Periodic approval poll (every 15s) as fallback for missed WebSocket events
  useEffect(() => {
    if (!mounted) return;
    const interval = setInterval(checkPendingApprovals, 15_000);
    return () => clearInterval(interval);
  }, [mounted, checkPendingApprovals]);

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
        setPendingPermission({
          requestId: data.requestId,
          skillId: data.skillId,
          action: data.action || data.toolName,
          args: data.args,
        });
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
        setPendingApproval({
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
          case 'stage_started':
            setStatusMessage(`Stage ${(pe.index ?? 0) + 1}: ${pe.name}...`);
            break;
          case 'stage_completed': {
            const note = pe.note ? ` (${pe.note})` : '';
            setStatusMessage(`Stage "${pe.name}" completed${note}`);
            // Add summary as a system message so it persists in the timeline
            if (pe.summary && sessionId) {
              updateSessionState(sessionId, (prev) => ({
                ...prev,
                messages: [...prev.messages, {
                  id: `stage-${pe.stageId || Date.now()}`,
                  role: 'system' as const,
                  content: `**${pe.name}** (${pe.role || 'agent'}) completed${note}: ${pe.summary}`,
                  timestamp: new Date(),
                }],
              }));
            }
            break;
          }
          case 'qa_retry': {
            setStatusMessage(`QA found issues — retrying implementation (attempt ${pe.attempt}/${pe.maxRetries})`);
            if (sessionId) {
              updateSessionState(sessionId, (prev) => ({
                ...prev,
                messages: [...prev.messages, {
                  id: `qa-retry-${pe.attempt}-${Date.now()}`,
                  role: 'system' as const,
                  content: `**QA Retry** (${pe.attempt}/${pe.maxRetries}): ${pe.issues?.join(', ') || 'Issues found, retrying implementation...'}`,
                  timestamp: new Date(),
                }],
              }));
            }
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
        updateSessionState(sessionId, (prev) => {
          const next = new Map(prev.trackedAgents);
          next.set(agentId, {
            id: agentId,
            role: d.role,
            model: d.model,
            status: 'running',
            toolCalls: [],
            startTime: Date.now(),
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
            // Create a completed entry so the duration is still visible
            next.set(agentId, {
              id: agentId,
              role: d.role || 'unknown',
              model: d.model || '',
              status: workerStatus,
              toolCalls: [],
              startTime: d.durationMs ? Date.now() - d.durationMs : Date.now(),
              endTime: Date.now(),
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
        updateSessionState(sessionId, (prev) => {
          const next = new Map(prev.trackedAgents);
          const existing = next.get(data.agentId);
          if (existing) {
            next.set(data.agentId, {
              ...existing,
              toolCalls: [...existing.toolCalls, ...toolCalls],
            });
          }
          return { ...prev, trackedAgents: next };
        });
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
        setPendingApproval(null);
        setPendingPermission(null);
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
    setPendingApproval(null);
    setPendingPermission(null);
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
      trackedAgents: new Map(),
      teams: new Map(),
    }));

    setIsLoading(true);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'chat',
        content: userInput,
        sessionId: sid,
        expertId: selectedPresetId || undefined,
      }));
      return;
    }

    // REST fallback
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
      if (sid) {
        updateSessionState(sid, (prev) => ({
          ...prev,
          messages: [...prev.messages, {
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: `Error: ${(error as Error).message}. Make sure the assistant backend is running.`,
            timestamp: new Date(),
          }],
        }));
      }
    }

    setIsLoading(false);
    setStatusMessage(null);
  };

  // Approval / Permission handling
  const handleApproval = (approved: boolean, response?: string) => {
    if (!pendingApproval) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'approval_response',
        requestId: pendingApproval.requestId,
        approved,
        response,
      }));
    } else {
      api.post('/chat/approve', { requestId: pendingApproval.requestId, approved, response }).catch(console.error);
    }
    setPendingApproval(null);
  };

  const handlePermissionResponse = (approved: boolean) => {
    if (!pendingPermission) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'permission_response',
        requestId: pendingPermission.requestId,
        approved,
      }));
    }
    setPendingPermission(null);
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
      <div className="w-64 border-r border-outline-variant/10 flex-shrink-0 bg-surface-container-low">
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
        {/* Inline banners for approval/permission */}
        {pendingPermission && (
          <div className="bg-yellow-900/20 border-b border-yellow-800/40 px-4 py-3 flex items-center justify-between">
            <div className="min-w-0 flex-1 mr-3">
              <p className="text-sm font-medium text-yellow-200">Permission Required</p>
              <p className="text-sm text-on-surface-variant">
                <span className="font-mono font-medium">{pendingPermission.skillId}</span>
                {' '}&middot;{' '}
                <span className="font-mono">{pendingPermission.action}</span>
              </p>
              {pendingPermission.args && Object.keys(pendingPermission.args).length > 0 && (
                <p className="text-xs text-on-surface-variant mt-1 font-mono truncate">
                  {Object.entries(pendingPermission.args)
                    .filter(([, v]) => v != null && String(v).length > 0)
                    .slice(0, 3)
                    .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
                    .join(' · ')}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={() => handlePermissionResponse(true)} className="flex items-center gap-1 px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 cursor-pointer">
                <CheckCircle className="w-4 h-4" /> Allow
              </button>
              <button onClick={() => handlePermissionResponse(false)} className="flex items-center gap-1 px-3 py-1.5 text-sm bg-error text-white rounded-lg hover:bg-error/80 cursor-pointer">
                <XCircle className="w-4 h-4" /> Deny
              </button>
            </div>
          </div>
        )}

        {pendingApproval && (
          <div className="bg-orange-900/20 border-b border-orange-800/40 px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-orange-200">Approval Required</p>
              <p className="text-sm text-on-surface-variant">{pendingApproval.summary}</p>
              <p className="text-sm font-medium text-white mt-0.5">{pendingApproval.question}</p>
            </div>
            <div className="flex gap-2 flex-wrap">
              {pendingApproval.options?.length ? (
                <>
                  {pendingApproval.options.map((option, i) => (
                    <button key={i} onClick={() => handleApproval(true, option)} className="px-3 py-1.5 text-sm bg-surface-container-highest border border-outline-variant/10 rounded-lg hover:bg-surface-container-high text-white cursor-pointer">
                      {option}
                    </button>
                  ))}
                  <button onClick={() => handleApproval(false)} className="px-3 py-1.5 text-sm bg-error/20 border border-error/30 rounded-lg hover:bg-error/30 text-error cursor-pointer">
                    Deny
                  </button>
                </>
              ) : (
                <>
                  <button onClick={() => handleApproval(true)} className="flex items-center gap-1 px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 cursor-pointer">
                    <CheckCircle className="w-4 h-4" /> Approve
                  </button>
                  <button onClick={() => handleApproval(false)} className="flex items-center gap-1 px-3 py-1.5 text-sm bg-error text-white rounded-lg hover:bg-error/80 cursor-pointer">
                    <XCircle className="w-4 h-4" /> Deny
                  </button>
                </>
              )}
            </div>
          </div>
        )}

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

      {/* Right panel — Side panel */}
      {showSidePanel && (
        <div className="w-72 border-l border-outline-variant/10 flex-shrink-0 bg-surface-container">
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
          />
        </div>
      )}

      {/* Side panel toggle */}
      <button
        onClick={() => setShowSidePanel(!showSidePanel)}
        className="absolute top-20 right-2 p-1.5 rounded-lg bg-surface-container-highest shadow-sm ring-1 ring-outline-variant/10 text-on-surface-variant hover:text-white z-10 cursor-pointer"
        title={showSidePanel ? 'Hide panel' : 'Show panel'}
      >
        {showSidePanel ? <PanelRightClose className="w-4 h-4" /> : <PanelRight className="w-4 h-4" />}
      </button>
    </div>
  );
}
