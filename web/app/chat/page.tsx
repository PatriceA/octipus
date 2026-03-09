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

// Per-session state
interface SessionState {
  messages: ChatMessageData[];
  trackedAgents: Map<string, TrackedAgent>;
  teams: Map<string, TeamState>;
  totalTokens: number;
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
      const data = await api.get<{ sessions: Array<{ id: string; title: string; updatedAt: string; messageCount: number; tokenCount?: number; status: string }>; maxTokenBudget?: number }>('/sessions');
      if (data?.maxTokenBudget != null) setMaxTokenBudget(data.maxTokenBudget);
      if (data?.sessions?.length) {
        const items: SessionInfo[] = data.sessions
          .filter(s => s.status === 'active')
          .slice(0, 50)
          .map(s => ({
            id: s.id,
            title: s.title || 'Untitled',
            updatedAt: s.updatedAt,
            messageCount: s.messageCount,
            tokenCount: s.tokenCount || 0,
            status: s.status,
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
        const agentData = await api.get<{ agents: Array<{ id: string; sessionId: string; role: string; model: string; status: string; createdAt: string; iteration: number }> }>('/agents');
        const sessionAgents = (agentData?.agents || []).filter(a => a.sessionId === sessionId);
        for (const a of sessionAgents) {
          let toolCalls: Array<{ id: string; name: string; argsSummary?: string }> = [];
          try {
            const evData = await api.get<{ events: Array<{ type: string; data: any }> }>(`/agents/${a.id}/events`);
            for (const ev of evData?.events || []) {
              if (ev.type === 'action' && ev.data?.toolCalls) {
                toolCalls.push(...ev.data.toolCalls.map((tc: any) => ({
                  id: tc.id || Date.now().toString(),
                  name: tc.name,
                  argsSummary: tc.argsSummary,
                })));
              }
            }
          } catch {}
          restoredAgents.set(a.id, {
            id: a.id,
            role: a.role,
            model: a.model,
            status: (a.status === 'running' || a.status === 'idle' ? 'running' : a.status === 'failed' ? 'failed' : 'completed') as TrackedAgent['status'],
            toolCalls,
            startTime: new Date(a.createdAt).getTime(),
            endTime: a.status !== 'running' && a.status !== 'idle' ? Date.now() : undefined,
            iterations: a.iteration,
          });
        }
      } catch {}

      updateSessionState(sessionId, (prev) => ({
        ...prev,
        messages: msgs,
        trackedAgents: restoredAgents.size > 0 ? restoredAgents : prev.trackedAgents,
      }));
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

  // WebSocket
  useEffect(() => {
    if (!mounted) return;
    const token = api.getToken();
    if (!token) return;

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
      ws.onopen = () => setConnectionStatus('connected');
      ws.onmessage = (event) => {
        try { handleWsMessage(JSON.parse(event.data)); } catch {}
      };
      ws.onclose = (event) => {
        if (event.code === 4000) return;
        if (wsInstance === ws) {
          setConnectionStatus('disconnected');
          wsRef.current = null;
          wsInstance = null;
        }
      };
      ws.onerror = () => {
        if (wsInstance === ws) setConnectionStatus('disconnected');
      };
    } catch {
      setConnectionStatus('disconnected');
    }

    return () => {};
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
          updateSessionState(sid, (prev) => ({
            ...prev,
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
          }));

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
            next.set(agentId, {
              ...existing,
              status: workerStatus,
              endTime: Date.now(),
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
      const toolCalls: ToolCallInfo[] = ((data.data as any)?.toolCalls || []).map((tc: any) => ({
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
  };

  // Session management
  const createSession = async () => {
    try {
      const result = await api.post<{ id: string; title: string; updatedAt: string; messageCount: number; status: string }>('/sessions', {
        channelType: 'webchat',
        channelId: `chat-${Date.now().toString(36)}`,
        title: 'New Chat',
      });
      if (result?.id) {
        const item: SessionInfo = {
          id: result.id,
          title: result.title || 'New Chat',
          updatedAt: result.updatedAt || new Date().toISOString(),
          messageCount: 0,
          tokenCount: 0,
          status: 'active',
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
    const sid = activeSessionId;

    const userMessage: ChatMessageData = {
      id: Date.now().toString(),
      role: 'user',
      content: userInput,
      timestamp: new Date(),
    };

    if (sid) {
      updateSessionState(sid, (prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage],
        trackedAgents: new Map(),
        teams: new Map(),
      }));
    }

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
      {/* Left panel — Session list */}
      <div className="w-64 border-r border-gray-200 dark:border-gray-800 flex-shrink-0 bg-white dark:bg-gray-900">
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
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-800 px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-yellow-900 dark:text-yellow-200">Permission Required</p>
              <p className="text-sm text-gray-700 dark:text-gray-300">
                <span className="font-mono">{pendingPermission.skillId}</span> wants to execute <span className="font-mono font-medium">{pendingPermission.action}</span>
              </p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => handlePermissionResponse(true)} className="flex items-center gap-1 px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 cursor-pointer">
                <CheckCircle className="w-4 h-4" /> Allow
              </button>
              <button onClick={() => handlePermissionResponse(false)} className="flex items-center gap-1 px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 cursor-pointer">
                <XCircle className="w-4 h-4" /> Deny
              </button>
            </div>
          </div>
        )}

        {pendingApproval && (
          <div className="bg-orange-50 dark:bg-orange-900/20 border-b border-orange-200 dark:border-orange-800 px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-orange-900 dark:text-orange-200">Approval Required</p>
              <p className="text-sm text-gray-700 dark:text-gray-300">{pendingApproval.summary}</p>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mt-0.5">{pendingApproval.question}</p>
            </div>
            <div className="flex gap-2 flex-wrap">
              {pendingApproval.options?.length ? (
                <>
                  {pendingApproval.options.map((option, i) => (
                    <button key={i} onClick={() => handleApproval(true, option)} className="px-3 py-1.5 text-sm bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 cursor-pointer">
                      {option}
                    </button>
                  ))}
                  <button onClick={() => handleApproval(false)} className="px-3 py-1.5 text-sm bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg hover:bg-red-100 text-red-700 dark:text-red-400 cursor-pointer">
                    Deny
                  </button>
                </>
              ) : (
                <>
                  <button onClick={() => handleApproval(true)} className="flex items-center gap-1 px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 cursor-pointer">
                    <CheckCircle className="w-4 h-4" /> Approve
                  </button>
                  <button onClick={() => handleApproval(false)} className="flex items-center gap-1 px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 cursor-pointer">
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
          isLoading={isLoading}
          statusMessage={statusMessage}
        />

        {/* Prompt input */}
        <div className="border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3">
          <PromptInput
            onSend={sendMessage}
            disabled={isLoading}
            placeholder={activeSessionId ? 'Send a message...' : 'Create a session to start chatting'}
          />
        </div>
      </div>

      {/* Right panel — Side panel */}
      {showSidePanel && (
        <div className="w-72 border-l border-gray-200 dark:border-gray-800 flex-shrink-0 bg-white dark:bg-gray-900">
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
        className="absolute top-20 right-2 p-1.5 rounded-lg bg-white dark:bg-gray-800 shadow-sm ring-1 ring-gray-200 dark:ring-gray-700 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 z-10 cursor-pointer"
        title={showSidePanel ? 'Hide panel' : 'Show panel'}
      >
        {showSidePanel ? <PanelRightClose className="w-4 h-4" /> : <PanelRight className="w-4 h-4" />}
      </button>
    </div>
  );
}
