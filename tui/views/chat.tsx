import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { api } from '../lib/api.js';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatResponse {
  response: string;
  sessionId: string;
  agentId?: string;
  classification?: string;
}

export function ChatView() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sendMessage = async () => {
    if (!input.trim() || isTyping) return;

    const userMessage = input.trim();
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setInput('');
    setIsTyping(true);
    setError(null);

    try {
      const body: Record<string, string> = { message: userMessage };
      if (sessionId) body.sessionId = sessionId;

      const data = await api.post<ChatResponse>('/chat', body);
      if (data.sessionId) setSessionId(data.sessionId);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: data.response || '(empty response)' },
      ]);
    } catch (err) {
      setError((err as Error).message);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${(err as Error).message}` },
      ]);
    } finally {
      setIsTyping(false);
    }
  };

  useInput((char, key) => {
    if (key.return) {
      sendMessage();
    } else if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
    } else if (!key.ctrl && !key.meta && char) {
      setInput((prev) => prev + char);
    }
  });

  return (
    <Box flexDirection="column" height="100%">
      <Text bold underline>
        Chat
      </Text>
      {sessionId && <Text color="cyan">Session: {sessionId.slice(0, 8)}...</Text>}

      {/* Messages */}
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {messages.length === 0 ? (
          <Text color="white">Start typing to begin a conversation...</Text>
        ) : (
          messages.slice(-10).map((msg, index) => (
            <Box key={index} marginBottom={1}>
              <Text color={msg.role === 'user' ? 'cyan' : 'green'} bold>
                {msg.role === 'user' ? 'You: ' : 'AI: '}
              </Text>
              <Text wrap="wrap">{msg.content}</Text>
            </Box>
          ))
        )}

        {isTyping && (
          <Box>
            <Text color="yellow">AI is thinking...</Text>
          </Box>
        )}
      </Box>

      {/* Input */}
      <Box borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text color="cyan">{'> '}</Text>
        <Text>{input}</Text>
        <Text color="yellow">_</Text>
      </Box>
    </Box>
  );
}
