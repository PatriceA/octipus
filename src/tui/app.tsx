import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { GatewayClient, type ConnectionStatus } from './gateway-client';

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
  const [client] = useState(() => new GatewayClient({
    url: gatewayUrl,
    onStatusChange: (s) => setStatus(s),
    onResponse: (response) => {
      setMessages(prev => [...prev, { role: 'assistant', content: response, timestamp: new Date() }]);
    },
    onCommandResult: (name, result, error) => {
      const content = error || (typeof result === 'string' ? result : JSON.stringify(result));
      setMessages(prev => [...prev, { role: 'system', content: `/${name}: ${content}`, timestamp: new Date() }]);
    },
    onEvent: (event) => {
      if (event.type === 'agent.spawned') {
        setMessages(prev => [...prev, {
          role: 'system',
          content: `Agent spawned: ${event.payload?.role || 'worker'}`,
          timestamp: new Date(),
        }]);
      }
    },
    onError: (error) => {
      setMessages(prev => [...prev, { role: 'system', content: `Error: ${error}`, timestamp: new Date() }]);
    },
  }));

  // Session ID — for now use a fixed one, could be made selectable
  const [sessionId] = useState('00000000-0000-0000-0000-000000000000');

  useEffect(() => {
    client.connect();
    return () => client.disconnect();
  }, [client]);

  const handleSubmit = useCallback((value: string) => {
    if (!value.trim()) return;
    setInput('');

    // Add user message to display
    setMessages(prev => [...prev, { role: 'user', content: value, timestamp: new Date() }]);

    // Check if it's a command
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

  // Ctrl+C to exit
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      client.disconnect();
      exit();
    }
  });

  const statusColor = status === 'connected' ? 'green'
    : status === 'connecting' || status === 'authenticating' ? 'yellow'
    : 'red';

  // Show last N messages
  const visibleMessages = messages.slice(-20);

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">Assistant TUI</Text>
        <Text> | </Text>
        <Text color={statusColor}>{status}</Text>
      </Box>

      {/* Chat messages */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {visibleMessages.map((msg, i) => (
          <Box key={i}>
            <Text
              color={msg.role === 'user' ? 'green' : msg.role === 'assistant' ? 'white' : 'gray'}
              dimColor={msg.role === 'system'}
            >
              {msg.role === 'user' ? '> ' : msg.role === 'assistant' ? '  ' : '  '}
              {msg.content}
            </Text>
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
