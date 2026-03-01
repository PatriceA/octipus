import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export function ChatView() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);

  const sendMessage = () => {
    if (!input.trim()) return;

    setMessages((prev) => [...prev, { role: 'user', content: input }]);
    setInput('');
    setIsTyping(true);

    // Simulate response (in real implementation, this comes from WebSocket)
    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'This is a simulated response. Connect to the API for real responses.' },
      ]);
      setIsTyping(false);
    }, 1000);
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

      {/* Messages */}
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {messages.length === 0 ? (
          <Text color="gray">Start typing to begin a conversation...</Text>
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
            <Text color="gray">AI is typing...</Text>
          </Box>
        )}
      </Box>

      {/* Input */}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="cyan">{'> '}</Text>
        <Text>{input}</Text>
        <Text color="gray">|</Text>
      </Box>
    </Box>
  );
}
