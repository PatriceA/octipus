'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Loader2, Bot, RefreshCw, Settings2, CheckCircle, XCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api, createWebSocket } from '@/lib/api';
import { ChatMessage, type ChatMessageData, type MessageMetadata } from '@/components/chat/chat-message';
import { AgentActivityCard, TeamCard, type TrackedAgent, type ToolCallInfo } from '@/components/chat/agent-activity-card';
import { ChatInput } from '@/components/chat/chat-input';
import { SessionStats } from '@/components/chat/session-stats';
import { PresetSelector } from '@/components/chat/preset-selector';

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

interface TeamState {
  id: string;
  memberIds: string[];
  status: 'running' | 'completed';
  durationMs?: number;
}

// Unified timeline entry — either a message or an agent card
type TimelineEntry =
  | { kind: 'message'; data: ChatMessageData; ts: number }
  | { kind: 'agent'; agentId: string; ts: number }
  | { kind: 'team'; teamId: string; ts: number };

// Module-level guard to prevent React Strict Mode double WebSocket connections
let wsInstance: WebSocket | null = null;

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [mounted, setMounted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'connecting'>('connecting');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [models, setModels] = useState<Array<{ name: string; isDefault: boolean }>>([]);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [trackedAgents, setTrackedAgents] = useState<Map<string, TrackedAgent>>(new Map());
  const [teams, setTeams] = useState<Map<string, TeamState>>(new Map());
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [sessionTotalTokens, setSessionTotalTokens] = useState(0);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Initialize — restore session from localStorage if available
  useEffect(() => {
    if (!mounted) {
      setMounted(true);

      const savedSessionId = localStorage.getItem('chat_session_id');
      if (savedSessionId) {
        setSessionId(savedSessionId);
        api.get<{ messages: Array<{ id: string; role: string; content: string; createdAt: string }> }>(
          `/sessions/${savedSessionId}/messages?roles=user,assistant,system`
        ).then((data) => {
          if (data?.messages?.length) {
            setMessages(data.messages.map((m) => ({
              id: m.id,
              role: m.role as ChatMessageData['role'],
              content: m.content,
              timestamp: new Date(m.createdAt),
            })));
          } else {
            setMessages([welcomeMessage()]);
          }
        }).catch(() => {
          localStorage.removeItem('chat_session_id');
          setSessionId(null);
          setMessages([welcomeMessage()]);
        });
      } else {
        setMessages([welcomeMessage()]);
      }
    }
  }, [mounted]);

  // Check connection via health endpoint and load models
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

  // WebSocket connection for real-time events
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
        setMessages(prev => [...prev, {
          id: Date.now().toString(),
          role: 'assistant',
          content: data.response,
          timestamp: new Date(),
          agentId: data.agentId,
          classification: data.classification?.type,
          metadata: meta,
        }]);
        if (data.sessionId) {
          setSessionId(data.sessionId);
          localStorage.setItem('chat_session_id', data.sessionId);
        }
        // Update session tokens
        if (meta?.tokens) {
          setSessionTotalTokens(prev => prev + meta.tokens!);
        }
        if (data.metadata?.sessionTotalTokens != null) {
          setSessionTotalTokens(data.metadata.sessionTotalTokens);
        }
        break;
      }

      case 'chat_error':
        setIsLoading(false);
        setStatusMessage(null);
        setMessages(prev => [...prev, {
          id: Date.now().toString(),
          role: 'assistant',
          content: `Error: ${data.error}`,
          timestamp: new Date(),
        }]);
        break;

      case 'orchestrator_event':
        handleOrchestratorEvent(data);
        break;

      case 'agent_event':
        handleAgentEvent(data);
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

  const handleOrchestratorEvent = (data: any) => {
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
        setTrackedAgents(prev => {
          const next = new Map(prev);
          next.set(agentId, {
            id: agentId,
            role: d.role,
            model: d.model,
            status: 'running',
            toolCalls: [],
            startTime: Date.now(),
            parentAgentId: d.parentAgentId,
          });
          return next;
        });
        break;
      }

      case 'worker_completed': {
        const d = data.data as any;
        const agentId = d.workerId;
        setTrackedAgents(prev => {
          const next = new Map(prev);
          const existing = next.get(agentId);
          if (existing) {
            next.set(agentId, {
              ...existing,
              status: 'completed',
              endTime: Date.now(),
              totalTokens: d.totalTokens,
              iterations: d.iterations,
            });
          }
          return next;
        });
        if (d.totalTokens) {
          setSessionTotalTokens(prev => prev + d.totalTokens);
        }
        break;
      }

      case 'team_started': {
        const d = data.data as any;
        setTeams(prev => {
          const next = new Map(prev);
          next.set(d.teamId, {
            id: d.teamId,
            memberIds: [],
            status: 'running',
          });
          return next;
        });
        break;
      }

      case 'team_completed': {
        const d = data.data as any;
        setTeams(prev => {
          const next = new Map(prev);
          const existing = next.get(d.teamId);
          if (existing) {
            next.set(d.teamId, { ...existing, status: 'completed', durationMs: d.durationMs });
          }
          return next;
        });
        break;
      }
    }
  };

  const handleAgentEvent = (data: any) => {
    if (data.event === 'action' && data.agentId) {
      const toolCalls: ToolCallInfo[] = ((data.data as any)?.toolCalls || []).map((tc: any) => ({
        id: tc.id || Date.now().toString(),
        name: tc.name,
        argsSummary: tc.argsSummary,
      }));
      setTrackedAgents(prev => {
        const next = new Map(prev);
        const existing = next.get(data.agentId);
        if (existing) {
          next.set(data.agentId, {
            ...existing,
            toolCalls: [...existing.toolCalls, ...toolCalls],
          });
        }
        return next;
      });
    }
  };

  // Build unified timeline
  const timeline: TimelineEntry[] = [];
  messages.forEach((msg) => {
    timeline.push({ kind: 'message', data: msg, ts: msg.timestamp.getTime() });
  });

  // Add non-orchestrator agents (orchestrator is invisible to user)
  const agentEntries = Array.from(trackedAgents.values()).filter(a => a.role !== 'orchestrator');
  const teamSet = new Set<string>();
  agentEntries.forEach((agent) => {
    if (agent.teamId) {
      if (!teamSet.has(agent.teamId)) {
        teamSet.add(agent.teamId);
        timeline.push({ kind: 'team', teamId: agent.teamId, ts: agent.startTime });
      }
    } else {
      timeline.push({ kind: 'agent', agentId: agent.id, ts: agent.startTime });
    }
  });

  // Also add standalone teams
  teams.forEach((team) => {
    if (!teamSet.has(team.id)) {
      timeline.push({ kind: 'team', teamId: team.id, ts: Date.now() });
    }
  });

  timeline.sort((a, b) => a.ts - b.ts);

  // Scroll to bottom on new messages/agents
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, trackedAgents]);

  // Send message
  const sendMessage = async (userInput: string) => {
    const userMessage: ChatMessageData = {
      id: Date.now().toString(),
      role: 'user',
      content: userInput,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setIsLoading(true);
    setTrackedAgents(new Map());
    setTeams(new Map());

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'chat',
        content: userInput,
        sessionId,
        presetId: selectedPresetId || undefined,
      }));
      return;
    }

    // Fallback to REST API
    try {
      const result = await api.post<{
        response: string;
        sessionId: string;
        agentId?: string;
        classification?: { type: string };
        metadata?: MessageMetadata;
      }>('/chat', { message: userInput, sessionId });

      if (result.sessionId) {
        setSessionId(result.sessionId);
        localStorage.setItem('chat_session_id', result.sessionId);
      }

      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: result.response,
        timestamp: new Date(),
        agentId: result.agentId,
        classification: result.classification?.type,
        metadata: result.metadata,
      }]);
    } catch (error) {
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Error: ${(error as Error).message}. Make sure the assistant backend is running.`,
        timestamp: new Date(),
      }]);
    }

    setIsLoading(false);
    setStatusMessage(null);
  };

  // Handle approval response
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
      api.post('/chat/approve', {
        requestId: pendingApproval.requestId,
        approved,
        response,
      }).catch(console.error);
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

  const clearChat = () => {
    setMessages([welcomeMessage()]);
    setSessionId(null);
    localStorage.removeItem('chat_session_id');
    setTrackedAgents(new Map());
    setTeams(new Map());
    setPendingApproval(null);
    setPendingPermission(null);
    setStatusMessage(null);
    setSessionTotalTokens(0);
    setSelectedPresetId(null);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Chat</h1>
          <div className="flex items-center gap-3 text-sm">
            {connectionStatus === 'connected' ? (
              <span className="text-green-600 flex items-center gap-1">
                <span className="w-2 h-2 bg-green-500 rounded-full" />
                Connected
              </span>
            ) : connectionStatus === 'connecting' ? (
              <span className="text-yellow-600 flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                Connecting...
              </span>
            ) : (
              <span className="text-red-600 flex items-center gap-1">
                <span className="w-2 h-2 bg-red-500 rounded-full" />
                Disconnected
              </span>
            )}
            <span className="text-gray-500">|</span>
            {/* Model selector */}
            <div className="relative">
              <button
                onClick={() => setShowModelSelect(!showModelSelect)}
                className="flex items-center gap-1 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
              >
                <Settings2 className="w-4 h-4" />
                <span className="font-mono text-xs">{selectedModel || 'auto'}</span>
              </button>
              {showModelSelect && models.length > 0 && (
                <div className="absolute top-full left-0 mt-1 bg-white dark:bg-gray-800 rounded-xl shadow-lg ring-1 ring-gray-200/60 dark:ring-gray-700/60 py-1 z-50 min-w-[200px]">
                  <button
                    onClick={() => { setSelectedModel(''); setShowModelSelect(false); }}
                    className={cn(
                      'w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-700',
                      !selectedModel ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600' : 'text-gray-700 dark:text-gray-300'
                    )}
                  >
                    auto (orchestrator decides)
                  </button>
                  {models.map((m) => (
                    <button
                      key={m.name}
                      onClick={() => { setSelectedModel(m.name); setShowModelSelect(false); }}
                      className={cn(
                        'w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-700',
                        m.name === selectedModel ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600' : 'text-gray-700 dark:text-gray-300'
                      )}
                    >
                      {m.name} {m.isDefault && <span className="text-xs text-gray-500">(default)</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <span className="text-gray-500">|</span>
            <SessionStats totalTokens={sessionTotalTokens} />
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={checkConnection}
            className="p-2 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
            title="Refresh connection"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
          <button
            onClick={clearChat}
            className="px-3 py-1 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            Clear Chat
          </button>
        </div>
      </div>

      {/* Preset selector */}
      <div className="mb-3">
        <PresetSelector selectedPresetId={selectedPresetId} onSelect={setSelectedPresetId} />
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60">
        {/* Unified timeline: messages + agent activity */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {timeline.map((entry, i) => {
            if (entry.kind === 'message') {
              return <ChatMessage key={entry.data.id} message={entry.data} />;
            }
            if (entry.kind === 'agent') {
              const agent = trackedAgents.get(entry.agentId);
              if (!agent) return null;
              return <AgentActivityCard key={`agent-${agent.id}`} agent={agent} />;
            }
            if (entry.kind === 'team') {
              const team = teams.get(entry.teamId);
              const memberAgents = Array.from(trackedAgents.values()).filter(a => a.teamId === entry.teamId);
              if (!team && memberAgents.length === 0) return null;
              return (
                <TeamCard
                  key={`team-${entry.teamId}`}
                  teamId={entry.teamId}
                  members={memberAgents}
                  status={team?.status || 'running'}
                  durationMs={team?.durationMs}
                />
              );
            }
            return null;
          })}

          {/* Loading / status indicator */}
          {isLoading && (
            <div className="flex gap-3 justify-start">
              <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center flex-shrink-0">
                <Bot className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              </div>
              <div className="bg-gray-100 dark:bg-gray-700 px-4 py-2 rounded-lg flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
                <span className="text-sm text-gray-500">
                  {statusMessage || 'Thinking...'}
                </span>
              </div>
            </div>
          )}

          {/* Permission request card */}
          {pendingPermission && (
            <div className="flex gap-3 justify-start">
              <div className="w-8 h-8 rounded-full bg-yellow-100 dark:bg-yellow-900 flex items-center justify-center flex-shrink-0">
                <Bot className="w-5 h-5 text-yellow-600 dark:text-yellow-400" />
              </div>
              <div className="max-w-[70%] bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 px-4 py-3 rounded-lg">
                <p className="text-sm font-medium text-yellow-900 dark:text-yellow-200 mb-1">Permission Required</p>
                <p className="text-sm text-gray-700 dark:text-gray-300 mb-1">
                  Skill <span className="font-mono font-medium">{pendingPermission.skillId}</span> wants to execute:
                </p>
                <p className="text-sm font-mono bg-yellow-100 dark:bg-yellow-900/40 px-2 py-1 rounded mb-3">
                  {pendingPermission.action}
                </p>
                <div className="flex gap-2">
                  <button onClick={() => handlePermissionResponse(true)} className="flex items-center gap-1 px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700">
                    <CheckCircle className="w-4 h-4" /> Allow
                  </button>
                  <button onClick={() => handlePermissionResponse(false)} className="flex items-center gap-1 px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">
                    <XCircle className="w-4 h-4" /> Deny
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Approval card */}
          {pendingApproval && (
            <div className="flex gap-3 justify-start">
              <div className="w-8 h-8 rounded-full bg-orange-100 dark:bg-orange-900 flex items-center justify-center flex-shrink-0">
                <Bot className="w-5 h-5 text-orange-600 dark:text-orange-400" />
              </div>
              <div className="max-w-[70%] bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 px-4 py-3 rounded-lg">
                <p className="text-sm font-medium text-orange-900 dark:text-orange-200 mb-1">Approval Required</p>
                <p className="text-sm text-gray-700 dark:text-gray-300 mb-1">{pendingApproval.summary}</p>
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">{pendingApproval.question}</p>
                {pendingApproval.options && pendingApproval.options.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {pendingApproval.options.map((option, i) => (
                      <button key={i} onClick={() => handleApproval(true, option)} className="px-3 py-1.5 text-sm bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300">
                        {option}
                      </button>
                    ))}
                    <button onClick={() => handleApproval(false)} className="px-3 py-1.5 text-sm bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg hover:bg-red-100 text-red-700 dark:text-red-400">
                      Deny
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button onClick={() => handleApproval(true)} className="flex items-center gap-1 px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700">
                      <CheckCircle className="w-4 h-4" /> Approve
                    </button>
                    <button onClick={() => handleApproval(false)} className="flex items-center gap-1 px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">
                      <XCircle className="w-4 h-4" /> Deny
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <ChatInput onSend={sendMessage} disabled={isLoading} />
      </div>
    </div>
  );
}

function welcomeMessage(): ChatMessageData {
  return {
    id: '0',
    role: 'system',
    content: 'Welcome! I\'m your AI assistant. I\'ll route your requests to the right specialist. How can I help you today?',
    timestamp: new Date(),
  };
}
