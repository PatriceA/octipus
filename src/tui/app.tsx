import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { GatewayClient, type ConnectionStatus } from './gateway-client';
import { randomBytes } from 'crypto';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  collapsed?: boolean; // for collapsible tool output
}

/** Strip variation selectors (U+FE0E, U+FE0F) that break terminal emoji rendering */
function sanitizeEmoji(text: string): string {
  return text.replace(/[\uFE0E\uFE0F]/g, '');
}

interface AgentStats {
  model?: string;
  role?: string;
  tokens?: number;
  durationMs?: number;
  costUsd?: number;
  iterations?: number;
}

// Braille spinner frames (from claw-code-parity)
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface TuiAppProps {
  gatewayUrl?: string;
}

export function TuiApp({ gatewayUrl }: TuiAppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'system', content: 'Welcome to the Assistant TUI. Type a message or use /help for commands.', timestamp: new Date() },
  ]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [activeExpert, setActiveExpert] = useState<string | null>(null);
  const [agentRunning, setAgentRunning] = useState(false);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [agentStats, setAgentStats] = useState<AgentStats>({});
  const [cumulativeStats, setCumulativeStats] = useState({ tokens: 0, cost: 0, turns: 0 });
  const [currentTool, setCurrentTool] = useState<string | null>(null);

  // Generate a real UUID for this TUI session
  const [sessionId] = useState(() => {
    const hex = randomBytes(16).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  });

  // Spinner animation
  useEffect(() => {
    if (!agentRunning) return;
    const interval = setInterval(() => {
      setSpinnerFrame(f => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(interval);
  }, [agentRunning]);

  const [client] = useState(() => new GatewayClient({
    url: gatewayUrl,
    onStatusChange: (s) => setStatus(s),
    onResponse: (response) => {
      setMessages(prev => [...prev, { role: 'assistant', content: response, timestamp: new Date() }]);
    },
    onCommandResult: (name, result, error) => {
      if (name === 'clear' && !error) {
        setMessages([{ role: 'system', content: 'Chat cleared.', timestamp: new Date() }]);
        return;
      }

      // Handle /cost command locally
      if (name === 'cost') {
        const content = `Token usage: ${cumulativeStats.tokens.toLocaleString()} tokens · ${cumulativeStats.turns} turns` +
          (cumulativeStats.cost > 0 ? ` · $${cumulativeStats.cost.toFixed(4)}` : '');
        setMessages(prev => [...prev, { role: 'system', content, timestamp: new Date() }]);
        return;
      }

      const content = error || (typeof result === 'string' ? result : JSON.stringify(result));
      setMessages(prev => [...prev, { role: 'system', content: `/${name}: ${content}`, timestamp: new Date() }]);

      // Track expert switch from command result
      if (name === 'expert' && !error && typeof result === 'string') {
        if (result.includes('Switched to')) {
          const match = result.match(/Switched to expert: (.+)\./);
          setActiveExpert(match ? match[1] : null);
        } else if (result.includes('reset')) {
          setActiveExpert(null);
        }
      }
    },
    onEvent: (event) => {
      const payload = event.payload as any;

      // Agent lifecycle
      if (event.type === 'agent.spawned') {
        const role = payload?.role || payload?.data?.role || 'worker';
        const model = payload?.model || payload?.data?.model || '';
        setAgentRunning(true);
        setAgentStats(prev => ({ ...prev, role, model }));
        setMessages(prev => [...prev, {
          role: 'system',
          content: `Agent spawned: ${role}${model ? ` (${model})` : ''}`,
          timestamp: new Date(),
        }]);
      }
      if (event.type === 'agent.completed') {
        setAgentRunning(false);
        setCurrentTool(null);
        const stats = payload?.stats || payload?.data;
        if (stats) {
          const tokens = stats.totalTokens || stats.total_tokens || 0;
          const cost = stats.totalCostUsd || stats.total_cost_usd || 0;
          setAgentStats(prev => ({
            ...prev,
            tokens,
            durationMs: stats.durationMs || stats.duration_ms,
            costUsd: cost,
            iterations: stats.iterations || stats.numTurns || stats.num_turns,
          }));
          setCumulativeStats(prev => ({
            tokens: prev.tokens + tokens,
            cost: prev.cost + cost,
            turns: prev.turns + 1,
          }));
        }
        setMessages(prev => [...prev, {
          role: 'system',
          content: 'Agent completed.',
          timestamp: new Date(),
        }]);
      }

      // Agent tool use
      if (event.type === 'agent.action') {
        const data = payload?.data || payload;
        if (data?.type === 'tool_call' || data?.type === 'cli_tool_use') {
          const toolName = data.toolName || data.tool_name || 'tool';
          setCurrentTool(toolName);
        }
        if (data?.type === 'cli_tool_result' || data?.type === 'tool_result') {
          setCurrentTool(null);
        }
      }

      // Chat responses
      if (event.type === 'chat.response') {
        const text = payload?.response?.response || payload?.response || '';
        if (text && typeof text === 'string') {
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant' && last?.content === text) return prev;
            return [...prev, { role: 'assistant', content: text, timestamp: new Date() }];
          });
        }
      }
    },
    onError: (error) => {
      setMessages(prev => [...prev, { role: 'system', content: `Error: ${error}`, timestamp: new Date() }]);
    },
  }));

  useEffect(() => {
    client.connect();
    return () => client.disconnect();
  }, [client]);

  const handleSubmit = useCallback((value: string) => {
    if (!value.trim()) return;
    setInput('');

    setMessages(prev => [...prev, { role: 'user', content: value, timestamp: new Date() }]);

    if (value.startsWith('/')) {
      const parts = value.slice(1).split(/\s+/);
      const cmdName = parts[0];
      const args: Record<string, string> = {};
      if (parts.length > 1) args.value = parts.slice(1).join(' ');

      if (cmdName === 'exit' || cmdName === 'quit') {
        client.disconnect();
        exit();
        return;
      }

      // Handle /cost locally
      if (cmdName === 'cost') {
        const content = `Token usage: ${cumulativeStats.tokens.toLocaleString()} tokens · ${cumulativeStats.turns} turns` +
          (cumulativeStats.cost > 0 ? ` · $${cumulativeStats.cost.toFixed(4)}` : '');
        setMessages(prev => [...prev, { role: 'system', content: `/cost: ${content}`, timestamp: new Date() }]);
        return;
      }

      client.sendCommand(cmdName, Object.keys(args).length > 0 ? args : undefined);
    } else {
      client.sendChat(sessionId, value);
    }
  }, [client, sessionId, exit, cumulativeStats]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      client.disconnect();
      exit();
    }
  });

  const statusColor = status === 'connected' ? 'green'
    : status === 'connecting' || status === 'authenticating' ? 'yellow'
    : 'red';

  const visibleMessages = messages.slice(-30);

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box borderStyle="single" borderColor="#A0B8CF" paddingX={1} justifyContent="space-between">
        <Box>
          <Text bold color="#A0B8CF">Assistant</Text>
          <Text> </Text>
          <Text color={statusColor}>●</Text>
          {activeExpert && (
            <>
              <Text> </Text>
              <Text color="yellow">⟨{activeExpert}⟩</Text>
            </>
          )}
        </Box>
        <Box>
          {cumulativeStats.tokens > 0 && (
            <Text color="gray">{cumulativeStats.tokens.toLocaleString()} tok</Text>
          )}
          {cumulativeStats.cost > 0 && (
            <Text color="gray"> · ${cumulativeStats.cost.toFixed(4)}</Text>
          )}
          <Text color="gray"> {sessionId.slice(0, 8)}</Text>
        </Box>
      </Box>

      {/* Chat messages */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {visibleMessages.map((msg, i) => (
          <Box key={i} flexDirection="column">
            {msg.role === 'user' ? (
              <Text color="green" bold>{'❯ '}{sanitizeEmoji(msg.content)}</Text>
            ) : msg.role === 'assistant' ? (
              <Text color="#FFFFFF" wrap="wrap">{'  '}{sanitizeEmoji(msg.content)}</Text>
            ) : (
              <Text color="#A0B8CF">{'  '}{sanitizeEmoji(msg.content)}</Text>
            )}
          </Box>
        ))}
      </Box>

      {/* Status bar — shows agent activity */}
      {agentRunning && (
        <Box paddingX={1}>
          <Text color="#7AA2D4">{SPINNER_FRAMES[spinnerFrame]} </Text>
          <Text color="#7AA2D4">
            {currentTool ? `Running ${currentTool}` : 'Thinking'}
            {agentStats.model ? ` · ${agentStats.model}` : ''}
          </Text>
        </Box>
      )}

      {/* Last agent stats (shown briefly after completion) */}
      {!agentRunning && agentStats.tokens && agentStats.tokens > 0 && (
        <Box paddingX={1}>
          <Text color="gray" dimColor>
            {'  '}📊 {agentStats.tokens?.toLocaleString()} tokens
            {agentStats.durationMs ? ` · ${(agentStats.durationMs / 1000).toFixed(1)}s` : ''}
            {agentStats.costUsd ? ` · $${agentStats.costUsd.toFixed(4)}` : ''}
            {agentStats.model ? ` · ${agentStats.model}` : ''}
            {agentStats.role ? ` · ${agentStats.role}` : ''}
          </Text>
        </Box>
      )}

      {/* Input */}
      <Box borderStyle="single" borderColor={agentRunning ? '#7AA2D4' : 'gray'} paddingX={1}>
        <Text color="green">{'❯ '}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={agentRunning ? 'Agent working...' : 'Type a message or /command...'}
        />
      </Box>
    </Box>
  );
}
