import { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { GatewayClient, type ConnectionStatus } from './gateway-client';
import { getFileCompletions, cancelFileCompletions, extractPathToken } from './file-completer';
import { randomBytes } from 'crypto';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

interface AgentStats {
  model?: string;
  role?: string;
  tokens?: number;
  durationMs?: number;
  costUsd?: number;
}

interface PendingPermission {
  requestId: string;
  toolName: string;
  detail: string;
}

// ── Tool state machine ──────────────────────────────────────────
type ToolState = 'pending' | 'executing' | 'completed' | 'error';
interface ToolExecution {
  name: string;
  state: ToolState;
  startedAt: number;
  preview?: string; // first line of output
}

// ── Paste tracking ──────────────────────────────────────────────
const PASTE_LINE_THRESHOLD = 10;

/** Strip variation selectors (U+FE0E, U+FE0F) that break terminal emoji rendering */
function sanitizeEmoji(text: string): string {
  return text.replace(/[\uFE0E\uFE0F]/g, '');
}

// Braille spinner frames
const SPINNER = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];

interface TuiAppProps {
  gatewayUrl?: string;
  projectPath?: string;
}

export function TuiApp({ gatewayUrl, projectPath: initialProjectPath }: TuiAppProps) {
  const { exit } = useApp();
  const [projectPath, setProjectPath] = useState<string | undefined>(initialProjectPath);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'system', content: initialProjectPath
        ? `Welcome to the Assistant TUI. Project: ${initialProjectPath.split(/[/\\]/).pop()}\nType a message or /help for commands.`
        : 'Welcome to the Assistant TUI. Type a message or /help for commands.', timestamp: new Date() },
  ]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [activeExpert, setActiveExpert] = useState<string | null>(null);
  const [agentRunning, setAgentRunning] = useState(false);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [agentStats, setAgentStats] = useState<AgentStats>({});
  const [cumulativeStats, setCumulativeStats] = useState({ tokens: 0, cost: 0, turns: 0 });
  const [currentTool, setCurrentTool] = useState<ToolExecution | null>(null);
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);

  // Paste marker state
  const [pastedContent, setPastedContent] = useState<string | null>(null);
  const [pastedLineCount, setPastedLineCount] = useState(0);
  const previousInputRef = useRef('');

  // File completion state
  const [completions, setCompletions] = useState<string[]>([]);
  const [completionIdx, setCompletionIdx] = useState(0);

  const [sessionId] = useState(() => {
    const hex = randomBytes(16).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  });

  // Spinner animation
  useEffect(() => {
    if (!agentRunning) return;
    const interval = setInterval(() => setSpinnerFrame(f => (f + 1) % SPINNER.length), 80);
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
        // Clear terminal scrollback + screen, then reset messages
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
        setMessages([{ role: 'system', content: 'Chat cleared.', timestamp: new Date() }]);
        setAgentStats({});
        setCumulativeStats({ tokens: 0, cost: 0, turns: 0 });
        return;
      }
      if (name === 'cost') {
        const content = `Token usage: ${cumulativeStats.tokens.toLocaleString()} tokens \u00B7 ${cumulativeStats.turns} turns` +
          (cumulativeStats.cost > 0 ? ` \u00B7 $${cumulativeStats.cost.toFixed(4)}` : '');
        setMessages(prev => [...prev, { role: 'system', content, timestamp: new Date() }]);
        return;
      }
      const content = error || (typeof result === 'string' ? result : JSON.stringify(result));
      setMessages(prev => [...prev, { role: 'system', content: `/${name}: ${content}`, timestamp: new Date() }]);

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

      // Permission request
      if (event.type === 'permission.request') {
        const toolName = payload?.toolName || payload?.action || 'unknown';
        const args = payload?.args as Record<string, unknown> | undefined;
        let detail = toolName;
        if (args) {
          const path = args.path || args.file_path || args.filename;
          const command = args.command;
          if (path) detail = `${toolName} \u2192 ${path}`;
          else if (command) {
            const cmd = String(command);
            detail = `${toolName} \u2192 ${cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd}`;
          }
        }
        setPendingPermission({ requestId: payload?.requestId, toolName, detail });
        return;
      }

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
          setAgentStats(prev => ({ ...prev, tokens, durationMs: stats.durationMs || stats.duration_ms, costUsd: cost }));
          setCumulativeStats(prev => ({ tokens: prev.tokens + tokens, cost: prev.cost + cost, turns: prev.turns + 1 }));
        }
        setMessages(prev => [...prev, { role: 'system', content: 'Agent completed.', timestamp: new Date() }]);
      }

      // Tool use — state machine: pending -> executing -> completed/error
      if (event.type === 'agent.action') {
        const data = payload?.data || payload;
        if (data?.type === 'tool_call' || data?.type === 'cli_tool_use') {
          const name = data.toolName || data.tool_name || 'tool';
          setCurrentTool({ name, state: 'pending', startedAt: Date.now() });
          // Transition to executing after a brief flash of pending
          setTimeout(() => {
            setCurrentTool(prev => prev && prev.name === name && prev.state === 'pending'
              ? { ...prev, state: 'executing' }
              : prev);
          }, 150);
        }
        if (data?.type === 'cli_tool_result' || data?.type === 'tool_result') {
          const isError = data.error || data.isError;
          const preview = typeof data.output === 'string' ? data.output.split('\n')[0]?.slice(0, 80) : undefined;
          setCurrentTool(prev => prev
            ? { ...prev, state: isError ? 'error' : 'completed', preview }
            : null);
          // Clear completed/error state after 1.5s
          setTimeout(() => {
            setCurrentTool(prev => prev && (prev.state === 'completed' || prev.state === 'error') ? null : prev);
          }, 1500);
        }
      }

      // Chat response
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

  // ── Input change handler: paste detection + file completion ──
  const handleInputChange = useCallback((value: string) => {
    const prev = previousInputRef.current;
    previousInputRef.current = value;

    // Paste detection: if a large chunk with many newlines arrives at once
    const delta = value.slice(prev.length);
    const newlineCount = (delta.match(/\n/g) || []).length;
    if (newlineCount > PASTE_LINE_THRESHOLD && delta.length > 50) {
      // Collapse the paste in the display
      const lineCount = newlineCount + 1;
      setPastedContent(value); // store full content
      setPastedLineCount(lineCount);
      setInput(`[pasted ${lineCount} lines]`);
      return;
    }

    setInput(value);

    // File completion: trigger when typing a path-like token
    const pathInfo = extractPathToken(value);
    if (pathInfo && pathInfo.token.length > 2) {
      getFileCompletions(pathInfo.token, process.cwd(), (results) => {
        setCompletions(results);
        setCompletionIdx(0);
      });
    } else {
      cancelFileCompletions();
      setCompletions([]);
    }
  }, []);

  const handleSubmit = useCallback((value: string) => {
    // If we have pasted content, send that instead of the marker
    const actualValue = pastedContent || value;
    if (!actualValue.trim()) return;
    setInput('');
    setPastedContent(null);
    setPastedLineCount(0);
    cancelFileCompletions();
    setCompletions([]);

    // Handle permission response
    if (pendingPermission) {
      const lower = actualValue.trim().toLowerCase();
      const approved = /^(y|yes|ok|allow|approve|sure|go)$/i.test(lower);
      const denied = /^(n|no|deny|reject|cancel|abort)$/i.test(lower);
      if (approved || denied) {
        client.respondPermission(pendingPermission.requestId, approved);
        setMessages(prev => [...prev, {
          role: 'system',
          content: approved ? `Approved: ${pendingPermission.toolName}` : `Denied: ${pendingPermission.toolName}`,
          timestamp: new Date(),
        }]);
        setPendingPermission(null);
        return;
      }
    }

    setMessages(prev => [...prev, { role: 'user', content: actualValue, timestamp: new Date() }]);

    if (actualValue.startsWith('/')) {
      const parts = actualValue.slice(1).split(/\s+/);
      const cmdName = parts[0];
      const args: Record<string, string> = {};
      if (parts.length > 1) args.value = parts.slice(1).join(' ');

      if (cmdName === 'exit' || cmdName === 'quit') { client.disconnect(); exit(); return; }
      if (cmdName === 'cost') {
        const content = `Token usage: ${cumulativeStats.tokens.toLocaleString()} tokens \u00B7 ${cumulativeStats.turns} turns` +
          (cumulativeStats.cost > 0 ? ` \u00B7 $${cumulativeStats.cost.toFixed(4)}` : '');
        setMessages(prev => [...prev, { role: 'system', content: `/cost: ${content}`, timestamp: new Date() }]);
        return;
      }
      if (cmdName === 'project') {
        const path = args.value?.trim();
        if (!path) {
          const current = projectPath || '(none)';
          setMessages(prev => [...prev, { role: 'system', content: `Current project: ${current}`, timestamp: new Date() }]);
        } else {
          setProjectPath(path);
          setMessages(prev => [...prev, { role: 'system', content: `Project set to: ${path}`, timestamp: new Date() }]);
        }
        return;
      }
      client.sendCommand(cmdName, Object.keys(args).length > 0 ? args : undefined);
    } else {
      client.sendChat(sessionId, actualValue, undefined, projectPath);
    }
  }, [client, sessionId, exit, cumulativeStats, pendingPermission, pastedContent, projectPath]);

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === 'c') { client.disconnect(); exit(); }
    // Tab: accept top file completion
    if (key.tab && completions.length > 0) {
      const pathInfo = extractPathToken(input);
      if (pathInfo) {
        const selected = completions[completionIdx] || completions[0];
        const newValue = input.slice(0, pathInfo.start) + selected;
        setInput(newValue);
        previousInputRef.current = newValue;
        setCompletions([]);
      }
    }
  });

  const _statusDot = status === 'connected' ? '\x1b[32m\u25CF\x1b[0m'
    : status === 'connecting' || status === 'authenticating' ? '\x1b[33m\u25CF\x1b[0m'
    : '\x1b[31m\u25CF\x1b[0m';

  const visibleMessages = messages.slice(-30);

  return (
    <Box flexDirection="column" height="100%">
      {/* Minimal header — just title + connection */}
      <Box paddingX={1}>
        <Text bold color="#A0B8CF">Assistant</Text>
        <Text> </Text>
        <Text color={status === 'connected' ? 'green' : status === 'error' ? 'red' : 'yellow'}>{'\u25CF'}</Text>
        {cumulativeStats.tokens > 0 && (
          <Text color="gray"> {'\u00B7'} {cumulativeStats.tokens.toLocaleString()} tok</Text>
        )}
      </Box>

      {/* Chat messages */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {visibleMessages.map((msg, i) => (
          <Box key={i} flexDirection="column">
            {msg.role === 'user' ? (
              <Text color="green" bold>{'\u276F '}{sanitizeEmoji(msg.content)}</Text>
            ) : msg.role === 'assistant' ? (
              <Text color="#FFFFFF" wrap="wrap">{'  '}{sanitizeEmoji(msg.content)}</Text>
            ) : msg.content.startsWith('Error') || msg.content.includes('failed') || msg.content.includes('error:') ? (
              <Text color="#C47070">{'  '}{sanitizeEmoji(msg.content)}</Text>
            ) : (
              <Text color="#A0B8CF">{'  '}{sanitizeEmoji(msg.content)}</Text>
            )}
          </Box>
        ))}
      </Box>

      {/* Activity bar — tool state machine display */}
      {agentRunning && !currentTool && (
        <Box paddingX={1}>
          <Text color="#7AA2D4">{SPINNER[spinnerFrame]} </Text>
          <Text color="#7AA2D4">
            Thinking
            {agentStats.model ? ` \u00B7 ${agentStats.model}` : ''}
          </Text>
        </Box>
      )}
      {currentTool && currentTool.state === 'pending' && (
        <Box paddingX={1}>
          <Text color="yellow">{'  '}Calling {currentTool.name}...</Text>
        </Box>
      )}
      {currentTool && currentTool.state === 'executing' && (
        <Box paddingX={1}>
          <Text color="cyan">{SPINNER[spinnerFrame]} Running {currentTool.name}...</Text>
          {currentTool.preview && (
            <Text color="gray"> {currentTool.preview.slice(0, 60)}</Text>
          )}
        </Box>
      )}
      {currentTool && currentTool.state === 'completed' && (
        <Box paddingX={1}>
          <Text color="green">{'\u2713'} {currentTool.name}</Text>
        </Box>
      )}
      {currentTool && currentTool.state === 'error' && (
        <Box paddingX={1}>
          <Text color="red">{'\u2717'} {currentTool.name}</Text>
        </Box>
      )}

      {/* Last agent stats */}
      {!agentRunning && agentStats.tokens && agentStats.tokens > 0 && (
        <Box paddingX={1}>
          <Text color="gray" dimColor>
            {'  '}{agentStats.tokens?.toLocaleString()} tok
            {agentStats.durationMs ? ` \u00B7 ${(agentStats.durationMs / 1000).toFixed(1)}s` : ''}
            {agentStats.costUsd ? ` \u00B7 $${agentStats.costUsd.toFixed(4)}` : ''}
            {agentStats.model ? ` \u00B7 ${agentStats.model}` : ''}
          </Text>
        </Box>
      )}

      {/* Permission prompt */}
      {pendingPermission && (
        <Box paddingX={1} borderStyle="single" borderColor="yellow">
          <Text color="yellow" bold>{'\u26A0'} Permission: </Text>
          <Text color="#FFFFFF">{pendingPermission.detail}</Text>
          <Text color="gray">  (y/n)</Text>
        </Box>
      )}

      {/* Footer — expert + session (always visible below chat) */}
      <Box paddingX={1} justifyContent="space-between">
        <Box>
          {activeExpert ? (
            <Text color="yellow">{'\u27E8'}{activeExpert}{'\u27E9'}</Text>
          ) : (
            <Text color="gray">auto-route</Text>
          )}
        </Box>
        {projectPath && (
          <Text color="cyan">{'\u{1F4C1}'} {projectPath.split(/[/\\]/).pop()}</Text>
        )}
        <Text color="gray">{sessionId.slice(0, 8)}</Text>
      </Box>

      {/* File completions dropdown */}
      {completions.length > 0 && (
        <Box paddingX={2} flexDirection="column">
          {completions.slice(0, 5).map((c, i) => (
            <Text key={c} color={i === completionIdx ? 'cyan' : 'gray'}>
              {i === completionIdx ? '\u276F ' : '  '}{c}
            </Text>
          ))}
          <Text color="gray" dimColor>  Tab to accept</Text>
        </Box>
      )}

      {/* Paste marker indicator */}
      {pastedContent && (
        <Box paddingX={2}>
          <Text color="yellow">[pasted {pastedLineCount} lines] - press Enter to send</Text>
        </Box>
      )}

      {/* Input */}
      <Box borderStyle="single" borderColor={pendingPermission ? 'yellow' : agentRunning ? '#7AA2D4' : 'gray'} paddingX={1}>
        <Text color="green">{'\u276F '}</Text>
        <TextInput
          value={input}
          onChange={handleInputChange}
          onSubmit={handleSubmit}
          placeholder={pendingPermission ? 'Type yes or no...' : agentRunning ? 'Agent working...' : 'Type a message or /command...'}
        />
      </Box>
    </Box>
  );
}
