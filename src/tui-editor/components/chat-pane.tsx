/**
 * <ChatPane> — agent conversation surface.
 *
 * Renders the message stream + an input that submits via the
 * gateway client. Permission prompts hijack the input until the
 * user responds y/n.
 */
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useState } from 'react';
import type { GatewayClient } from '../../tui/gateway-client';
import { agentStore } from '../app';
import { useStore } from '../stores/use-store';
import { getTheme } from '../theme';

interface Props {
  client: GatewayClient;
  sessionId: string;
  focused: boolean;
}

export function ChatPane({ client, sessionId, focused }: Props) {
  const theme = getTheme();
  const messages = useStore(agentStore, (s) => s.messages);
  const pending = useStore(agentStore, (s) => s.pendingPermission);
  const running = useStore(agentStore, (s) => s.agentRunning);
  const tool = useStore(agentStore, (s) => s.currentTool);
  const [text, setText] = useState('');

  useInput((_, key) => {
    if (!focused) return;
    if (key.escape) {
      // Double-esc → abort agent (TODO Phase 4 wire).
      return;
    }
  });

  const submit = (value: string) => {
    if (!value.trim()) return;
    setText('');
    if (pending) {
      const lower = value.trim().toLowerCase();
      const approved = /^(y|yes|ok|allow|approve)$/i.test(lower);
      const denied = /^(n|no|deny|reject|cancel)$/i.test(lower);
      if (approved || denied) {
        client.respondPermission(pending.requestId, approved);
        agentStore.pushMessage('system', approved
          ? `Approved: ${pending.toolName}`
          : `Denied: ${pending.toolName}`);
        agentStore.setPendingPermission(null);
        return;
      }
    }
    agentStore.pushMessage('user', value);
    if (value.startsWith('/')) {
      const parts = value.slice(1).split(/\s+/);
      const cmd = parts[0];
      const args = parts.length > 1 ? { value: parts.slice(1).join(' ') } : undefined;
      client.sendCommand(cmd, args);
      return;
    }
    client.sendChat(sessionId, value);
  };

  const visible = messages.slice(-200);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((m) => (
          <Box key={m.id} flexDirection="column">
            {m.role === 'user' ? (
              <Text color={theme.ok} bold>❯ {m.content}</Text>
            ) : m.role === 'assistant' ? (
              <Text color={theme.fg} wrap="wrap">  {m.content}</Text>
            ) : (
              <Text color={m.content.startsWith('Error') ? theme.error : theme.statusFg}>
                {'  '}{m.content}
              </Text>
            )}
          </Box>
        ))}
      </Box>
      {tool && (
        <Box>
          <Text color={tool.state === 'error' ? theme.error : theme.accent}>
            {tool.state === 'completed' ? '✓ ' : tool.state === 'error' ? '✗ ' : '… '}
            {tool.name}
          </Text>
          {tool.preview && <Text color={theme.dim}> {tool.preview.slice(0, 40)}</Text>}
        </Box>
      )}
      {pending ? (
        <Box borderStyle="single" borderColor={theme.warn} paddingX={1}>
          <Text color={theme.warn} bold>⚠ </Text>
          <Text color={theme.fg}>{pending.detail}</Text>
          <Text color={theme.dim}>  (y/n)</Text>
        </Box>
      ) : (
        <Box borderStyle="single" borderColor={focused ? theme.borderFocus : theme.border} paddingX={1}>
          <Text color={theme.ok}>❯ </Text>
          {focused ? (
            <TextInput
              value={text}
              onChange={setText}
              onSubmit={submit}
              placeholder={running ? 'agent working…' : 'type a message or /command'}
            />
          ) : (
            <Text color={theme.dim}>(focus chat with Ctrl+\)</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
