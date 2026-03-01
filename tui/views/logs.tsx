import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  component?: string;
}

export function LogsView() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const [paused, setPaused] = useState(false);

  // Simulate log entries (in real implementation, this would come from a log stream)
  useEffect(() => {
    if (paused) return;

    const sampleLogs: LogEntry[] = [
      { timestamp: new Date().toISOString(), level: 'info', message: 'Gateway started', component: 'core' },
      { timestamp: new Date().toISOString(), level: 'info', message: 'Database connected', component: 'db' },
      { timestamp: new Date().toISOString(), level: 'info', message: 'Redis connected', component: 'db' },
      { timestamp: new Date().toISOString(), level: 'info', message: 'API server listening on port 3000', component: 'api' },
    ];

    setLogs(sampleLogs);
  }, [paused]);

  useInput((input) => {
    if (input === 'p') setPaused(!paused);
    if (input === 'a') setFilter('all');
    if (input === 'i') setFilter('info');
    if (input === 'w') setFilter('warn');
    if (input === 'e') setFilter('error');
    if (input === 'c') setLogs([]);
  });

  const levelColor = (level: string) => {
    switch (level) {
      case 'error':
        return 'red';
      case 'warn':
        return 'yellow';
      case 'debug':
        return 'gray';
      default:
        return 'green';
    }
  };

  const filteredLogs = filter === 'all' ? logs : logs.filter((l) => l.level === filter);

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold underline>
          Logs
        </Text>
        <Box>
          <Text color="gray">
            Filter: {filter} | {paused ? 'PAUSED' : 'LIVE'}
          </Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column" flexGrow={1}>
        {filteredLogs.length === 0 ? (
          <Text color="gray">No logs to display</Text>
        ) : (
          filteredLogs.slice(-20).map((log, index) => (
            <Box key={index}>
              <Text color="gray">{new Date(log.timestamp).toLocaleTimeString()} </Text>
              <Text color={levelColor(log.level)}>[{log.level.toUpperCase().padEnd(5)}] </Text>
              {log.component && <Text color="cyan">[{log.component}] </Text>}
              <Text>{log.message}</Text>
            </Box>
          ))
        )}
      </Box>

      <Box marginTop={1}>
        <Text color="gray">
          [p] Pause/Resume | [a] All | [i] Info | [w] Warn | [e] Error | [c] Clear
        </Text>
      </Box>
    </Box>
  );
}
