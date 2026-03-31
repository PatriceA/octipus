import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { GatewayClient, type ConnectionStatus } from './gateway-client';
import { randomBytes } from 'crypto';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

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

  // Generate a real UUID for this TUI session
  const [sessionId] = useState(() => {
    const hex = randomBytes(16).toString('hex');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
  });

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
        setMessages(prev => [...prev, {
          role: 'system',
          content: `Agent spawned: ${role}${model ? ` (${model})` : ''}`,
          timestamp: new Date(),
        }]);
      }
      if (event.type === 'agent.completed') {
        setMessages(prev => [...prev, {
          role: 'system',
          content: 'Agent completed.',
          timestamp: new Date(),
        }]);
      }

      // Chat responses (published by orchestrator/gateway after agent finishes)
      if (event.type === 'chat.response') {
        const text = payload?.response?.response || payload?.response || '';
        if (text && typeof text === 'string') {
          setMessages(prev => {
            // Avoid duplicate if onResponse already added it
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

      client.sendCommand(cmdName, Object.keys(args).length > 0 ? args : undefined);
    } else {
      client.sendChat(sessionId, value);
    }
  }, [client, sessionId, exit]);

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
      <Box borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">Assistant TUI</Text>
        <Text> | </Text>
        <Text color={statusColor}>{status}</Text>
        {activeExpert && (
          <>
            <Text> | </Text>
            <Text color="yellow">{activeExpert}</Text>
          </>
        )}
        <Text color="gray"> | {sessionId.slice(0, 8)}</Text>
      </Box>

      {/* Chat messages */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {visibleMessages.map((msg, i) => (
          <Box key={i}>
            {msg.role === 'user' ? (
              <Text color="green" bold>{'> '}{msg.content}</Text>
            ) : msg.role === 'assistant' ? (
              <Text color="white">{'  '}{msg.content}</Text>
            ) : (
              <Text color="cyan">{'  '}{msg.content}</Text>
            )}
          </Box>
        ))}
      </Box>

      {/* Input */}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="green">{'> '}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder="Type a message or /command..."
        />
      </Box>
    </Box>
  );
}
