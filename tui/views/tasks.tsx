import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { api } from '../lib/api.js';

interface RecurringTask {
  id: string;
  name: string;
  cronExpression: string;
  isEnabled: boolean;
  status: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runCount: number;
  lastError: string | null;
}

export function TasksView() {
  const [tasks, setTasks] = useState<RecurringTask[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const data = await api.get('/recurring-tasks') as { tasks: RecurringTask[] };
        setTasks(data?.tasks || []);
      } catch (err) {
        setError((err as Error).message);
      }
    };
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  if (error) {
    return <Box><Text color="red">Error: {error}</Text></Box>;
  }

  const fmt = (d: string | null) => {
    if (!d) return '—';
    return new Date(d).toLocaleTimeString();
  };

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Recurring Tasks ({tasks.length})</Text>
      <Box marginTop={1} flexDirection="column">
        {/* Header */}
        <Box>
          <Box width={20}><Text bold color="gray">Name</Text></Box>
          <Box width={16}><Text bold color="gray">Schedule</Text></Box>
          <Box width={10}><Text bold color="gray">Status</Text></Box>
          <Box width={12}><Text bold color="gray">Last Run</Text></Box>
          <Box width={12}><Text bold color="gray">Next Run</Text></Box>
          <Box width={6}><Text bold color="gray">Runs</Text></Box>
        </Box>

        {tasks.length === 0 ? (
          <Box marginTop={1}>
            <Text color="gray">No recurring tasks configured.</Text>
          </Box>
        ) : (
          tasks.map((task) => (
            <Box key={task.id}>
              <Box width={20}>
                <Text color="white">{task.name.slice(0, 18)}</Text>
              </Box>
              <Box width={16}>
                <Text color="gray">{task.cronExpression}</Text>
              </Box>
              <Box width={10}>
                <Text color={
                  task.isEnabled && task.status === 'active' ? 'green' :
                  task.status === 'error' ? 'red' : 'yellow'
                }>
                  {task.isEnabled ? task.status : 'paused'}
                </Text>
              </Box>
              <Box width={12}>
                <Text color="gray">{fmt(task.lastRunAt)}</Text>
              </Box>
              <Box width={12}>
                <Text color="gray">{fmt(task.nextRunAt)}</Text>
              </Box>
              <Box width={6}>
                <Text color="gray">{task.runCount}</Text>
              </Box>
            </Box>
          ))
        )}

        {tasks.some(t => t.lastError) && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color="red">Errors:</Text>
            {tasks.filter(t => t.lastError).map(t => (
              <Text key={t.id} color="red">  {t.name}: {t.lastError}</Text>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}
