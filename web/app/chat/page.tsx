'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Loader2, Bot, User, RefreshCw, Settings2, Activity, CheckCircle, XCircle, ChevronDown, ChevronUp, Mic, MicOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api, createWebSocket } from '@/lib/api';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  agentId?: string;
  classification?: string;
}

interface AgentActivity {
  type: string;
  data: unknown;
  timestamp: Date;
}

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

// Module-level guard to prevent React Strict Mode double WebSocket connections
let wsInstance: WebSocket | null = null;

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [mounted, setMounted] = useState(false);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'connecting'>('connecting');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [models, setModels] = useState<Array<{ name: string; isDefault: boolean }>>([]);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [agentActivity, setAgentActivity] = useState<AgentActivity[]>([]);
  const [showActivity, setShowActivity] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const recognitionRef = useRef<any>(null);

  // Initialize — restore session from localStorage if available
  useEffect(() => {
    if (!mounted) {
      setMounted(true);

      const savedSessionId = localStorage.getItem('chat_session_id');
      if (savedSessionId) {
        setSessionId(savedSessionId);
        // Restore message history from backend
        api.get<{ messages: Array<{ id: string; role: string; content: string; createdAt: string }> }>(
          `/sessions/${savedSessionId}/messages`
        ).then((data) => {
          if (data?.messages?.length) {
            setMessages(data.messages.map((m) => ({
              id: m.id,
              role: m.role as Message['role'],
              content: m.content,
              timestamp: new Date(m.createdAt),
            })));
          } else {
            // Session exists but no messages — show welcome
            setMessages([{
              id: '0',
              role: 'system',
              content: 'Welcome! I\'m your AI assistant. I\'ll route your requests to the right specialist. How can I help you today?',
              timestamp: new Date(),
            }]);
          }
        }).catch(() => {
          // Session not found or error — clear stale ID, show welcome
          localStorage.removeItem('chat_session_id');
          setSessionId(null);
          setMessages([{
            id: '0',
            role: 'system',
            content: 'Welcome! I\'m your AI assistant. I\'ll route your requests to the right specialist. How can I help you today?',
            timestamp: new Date(),
          }]);
        });
      } else {
        setMessages([{
          id: '0',
          role: 'system',
          content: 'Welcome! I\'m your AI assistant. I\'ll route your requests to the right specialist. How can I help you today?',
          timestamp: new Date(),
        }]);
      }
    }
  }, [mounted]);

  // Speech recognition setup
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      setSpeechSupported(true);
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onresult = (event: any) => {
        let transcript = '';
        for (let i = 0; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        setInput(transcript);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognition.onerror = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    }
  }, []);

  const toggleListening = () => {
    if (!recognitionRef.current) return;
    if (isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
    } else {
      recognitionRef.current.start();
      setIsListening(true);
    }
  };

  // Check connection via health endpoint and load models
  const checkConnection = useCallback(async () => {
    try {
      const health = await api.get<{ status: string }>('/health');
      if (health?.status === 'ok') {
        setConnectionStatus('connected');
      }
    } catch {
      setConnectionStatus('disconnected');
    }

    // Load available models
    try {
      const data = await api.get<{ models: Array<{ name: string; isDefault: boolean }> }>('/models');
      if (data?.models) {
        setModels(data.models);
        const defaultModel = data.models.find(m => m.isDefault);
        if (defaultModel && !selectedModel) {
          setSelectedModel(defaultModel.name);
        }
      }
    } catch {
      // Models endpoint may fail if not authenticated yet
    }
  }, [selectedModel]);

  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  // WebSocket connection for real-time events
  useEffect(() => {
    if (!mounted) return;

    const token = api.getToken();
    if (!token) return;

    // Reuse existing module-level connection (survives React Strict Mode remounts)
    if (wsInstance && wsInstance.readyState <= WebSocket.OPEN) {
      wsRef.current = wsInstance;
      // Re-attach message handler (previous closure was from old render)
      wsInstance.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleWsMessage(data);
        } catch {
          // Ignore unparseable messages
        }
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
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleWsMessage(data);
        } catch {
          // Ignore unparseable messages
        }
      };

      ws.onclose = (event) => {
        // If superseded by a newer connection (code 4000), don't update state
        if (event.code === 4000) return;
        // Only clear if this is still the active connection
        if (wsInstance === ws) {
          setConnectionStatus('disconnected');
          wsRef.current = null;
          wsInstance = null;
        }
      };

      ws.onerror = () => {
        if (wsInstance === ws) {
          setConnectionStatus('disconnected');
        }
      };
    } catch {
      setConnectionStatus('disconnected');
    }

    return () => {
      // Don't close the WebSocket on cleanup — let it persist across Strict Mode remounts.
      // It will be closed when the page navigates away (onclose fires naturally).
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  const handleWsMessage = (data: any) => {
    switch (data.type) {
      case 'connected':
        setConnectionStatus('connected');
        break;

      case 'chat_response':
        setIsLoading(false);
        setStatusMessage(null);
        setMessages(prev => [
          ...prev,
          {
            id: Date.now().toString(),
            role: 'assistant',
            content: data.response,
            timestamp: new Date(),
            agentId: data.agentId,
            classification: data.classification?.type,
          },
        ]);
        if (data.sessionId) {
          setSessionId(data.sessionId);
          localStorage.setItem('chat_session_id', data.sessionId);
        }
        break;

      case 'chat_error':
        setIsLoading(false);
        setStatusMessage(null);
        setMessages(prev => [
          ...prev,
          {
            id: Date.now().toString(),
            role: 'assistant',
            content: `Error: ${data.error}`,
            timestamp: new Date(),
          },
        ]);
        break;

      case 'orchestrator_event':
        handleOrchestratorEvent(data);
        break;

      case 'agent_event':
        setAgentActivity(prev => [
          ...prev.slice(-50), // Keep last 50 events
          { type: data.event, data: data.data, timestamp: new Date(data.timestamp) },
        ]);
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

      case 'worker_spawned':
        setAgentActivity(prev => [
          ...prev.slice(-50),
          { type: 'worker_spawned', data: data.data, timestamp: new Date(data.timestamp) },
        ]);
        break;

      case 'worker_completed':
        setAgentActivity(prev => [
          ...prev.slice(-50),
          { type: 'worker_completed', data: data.data, timestamp: new Date(data.timestamp) },
        ]);
        break;
    }
  };

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Send message — prefer WebSocket, fall back to REST
  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    const userInput = input;
    setInput('');
    setIsLoading(true);
    setAgentActivity([]);

    // Try WebSocket first
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'chat',
        content: userInput,
        sessionId,
      }));
      return; // Response comes via WebSocket
    }

    // Fallback to REST API
    try {
      const result = await api.post<{
        response: string;
        sessionId: string;
        agentId?: string;
        classification?: { type: string };
      }>('/chat', {
        message: userInput,
        sessionId,
      });

      if (result.sessionId) {
        setSessionId(result.sessionId);
        localStorage.setItem('chat_session_id', result.sessionId);
      }

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: result.response,
        timestamp: new Date(),
        agentId: result.agentId,
        classification: result.classification?.type,
      };
      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Error: ${(error as Error).message}. Make sure the assistant backend is running.`,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorMessage]);
    }

    setIsLoading(false);
    setStatusMessage(null);
  };

  // Handle approval response
  const handleApproval = (approved: boolean, response?: string) => {
    if (!pendingApproval) return;

    // Send via WebSocket
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'approval_response',
        requestId: pendingApproval.requestId,
        approved,
        response,
      }));
    } else {
      // Fallback to REST
      api.post('/chat/approve', {
        requestId: pendingApproval.requestId,
        approved,
        response,
      }).catch(console.error);
    }

    setPendingApproval(null);
  };

  // Handle permission response
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
    setMessages([
      {
        id: '0',
        role: 'system',
        content: 'Chat cleared. How can I help you?',
        timestamp: new Date(),
      },
    ]);
    setSessionId(null);
    localStorage.removeItem('chat_session_id');
    setAgentActivity([]);
    setPendingApproval(null);
    setPendingPermission(null);
    setStatusMessage(null);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Chat</h1>
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
            <span className="text-gray-400">|</span>
            {/* Model selector */}
            <div className="relative">
              <button
                onClick={() => setShowModelSelect(!showModelSelect)}
                className="flex items-center gap-1 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              >
                <Settings2 className="w-4 h-4" />
                <span className="font-mono text-xs">{selectedModel || 'auto'}</span>
              </button>
              {showModelSelect && models.length > 0 && (
                <div className="absolute top-full left-0 mt-1 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50 min-w-[200px]">
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
                      {m.name} {m.isDefault && <span className="text-xs text-gray-400">(default)</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          {agentActivity.length > 0 && (
            <button
              onClick={() => setShowActivity(!showActivity)}
              className="flex items-center gap-1 p-2 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
              title="Agent activity"
            >
              <Activity className="w-5 h-5" />
              <span className="text-xs">{agentActivity.length}</span>
              {showActivity ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          )}
          <button
            onClick={checkConnection}
            className="p-2 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
            title="Refresh connection"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
          <button
            onClick={clearChat}
            className="px-3 py-1 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            Clear Chat
          </button>
        </div>
      </div>

      {/* Agent Activity Panel */}
      {showActivity && agentActivity.length > 0 && (
        <div className="mb-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700 p-3 max-h-48 overflow-y-auto">
          <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Agent Activity</h3>
          <div className="space-y-1">
            {agentActivity.map((activity, i) => (
              <div key={i} className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span className="text-gray-400" suppressHydrationWarning>
                  {activity.timestamp.toLocaleTimeString()}
                </span>
                <span className={cn(
                  'px-1.5 py-0.5 rounded font-mono',
                  activity.type === 'worker_spawned' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400' :
                  activity.type === 'worker_completed' ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' :
                  activity.type === 'thought' ? 'bg-gray-100 dark:bg-gray-700 text-gray-600' :
                  activity.type === 'action' ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400' :
                  activity.type === 'error' ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400' :
                  'bg-gray-100 dark:bg-gray-700 text-gray-600'
                )}>
                  {activity.type}
                </span>
                <span className="truncate">
                  {typeof activity.data === 'object' && activity.data
                    ? JSON.stringify(activity.data).slice(0, 80)
                    : String(activity.data)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Chat area */}
      <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((message) => (
            <div
              key={message.id}
              className={cn(
                'flex gap-3',
                message.role === 'user' ? 'justify-end' : 'justify-start'
              )}
            >
              {message.role !== 'user' && (
                <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center flex-shrink-0">
                  <Bot className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                </div>
              )}
              <div
                className={cn(
                  'max-w-[70%] px-4 py-2 rounded-lg',
                  message.role === 'user'
                    ? 'bg-blue-600 text-white'
                    : message.role === 'system'
                    ? 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 italic'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white'
                )}
              >
                <p className="whitespace-pre-wrap">{message.content}</p>
                <div className="flex items-center gap-2 mt-1">
                  <p className="text-xs opacity-60" suppressHydrationWarning>
                    {message.timestamp.toLocaleTimeString()}
                  </p>
                  {message.classification && message.classification !== 'casual' && (
                    <span className="text-xs opacity-50 font-mono">
                      [{message.classification}]
                    </span>
                  )}
                </div>
              </div>
              {message.role === 'user' && (
                <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0">
                  <User className="w-5 h-5 text-white" />
                </div>
              )}
            </div>
          ))}

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
                <p className="text-sm font-medium text-yellow-900 dark:text-yellow-200 mb-1">
                  Permission Required
                </p>
                <p className="text-sm text-gray-700 dark:text-gray-300 mb-1">
                  Skill <span className="font-mono font-medium">{pendingPermission.skillId}</span> wants to execute:
                </p>
                <p className="text-sm font-mono bg-yellow-100 dark:bg-yellow-900/40 px-2 py-1 rounded mb-3">
                  {pendingPermission.action}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => handlePermissionResponse(true)}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700"
                  >
                    <CheckCircle className="w-4 h-4" />
                    Allow
                  </button>
                  <button
                    onClick={() => handlePermissionResponse(false)}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"
                  >
                    <XCircle className="w-4 h-4" />
                    Deny
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
                <p className="text-sm font-medium text-orange-900 dark:text-orange-200 mb-1">
                  Approval Required
                </p>
                <p className="text-sm text-gray-700 dark:text-gray-300 mb-1">
                  {pendingApproval.summary}
                </p>
                <p className="text-sm font-medium text-gray-900 dark:text-white mb-3">
                  {pendingApproval.question}
                </p>
                {pendingApproval.options && pendingApproval.options.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {pendingApproval.options.map((option, i) => (
                      <button
                        key={i}
                        onClick={() => handleApproval(true, option)}
                        className="px-3 py-1.5 text-sm bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300"
                      >
                        {option}
                      </button>
                    ))}
                    <button
                      onClick={() => handleApproval(false)}
                      className="px-3 py-1.5 text-sm bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg hover:bg-red-100 text-red-700 dark:text-red-400"
                    >
                      Deny
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleApproval(true)}
                      className="flex items-center gap-1 px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700"
                    >
                      <CheckCircle className="w-4 h-4" />
                      Approve
                    </button>
                    <button
                      onClick={() => handleApproval(false)}
                      className="flex items-center gap-1 px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"
                    >
                      <XCircle className="w-4 h-4" />
                      Deny
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="border-t border-gray-200 dark:border-gray-700 p-4">
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendMessage()}
              placeholder={isListening ? 'Listening...' : 'Send a message...'}
              className={cn(
                'flex-1 px-4 py-2 bg-gray-100 dark:bg-gray-700 border-0 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 dark:text-white',
                isListening && 'ring-2 ring-red-400'
              )}
              disabled={isLoading}
            />
            {speechSupported && (
              <button
                onClick={toggleListening}
                disabled={isLoading}
                className={cn(
                  'px-3 py-2 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed',
                  isListening
                    ? 'bg-red-600 text-white hover:bg-red-700'
                    : 'bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-500'
                )}
                title={isListening ? 'Stop listening' : 'Voice input'}
              >
                {isListening ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
              </button>
            )}
            <button
              onClick={sendMessage}
              disabled={isLoading || !input.trim()}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
