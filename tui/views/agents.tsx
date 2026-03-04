import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { api } from '../lib/api.js';

interface Agent {
  id: string;
  topic: string;
  model: string;
  status: string;
  iteration: number;
  createdAt: string;
}

export function AgentsView() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    const fetchAgents = async () => {
      try {
        const data = await api.get<{ agents: Agent[] }>('/agents');
        setAgents(data.agents || []);
        setLoading(false);
      } catch (err) {
        setError((err as Error).message);
        setLoading(false);
      }
    };

    fetchAgents();
    const interval = setInterval(fetchAgents, 3000);
    return () => clearInterval(interval);
  }, []);

  useInput((input, key) => {
    if (key.upArrow && selectedIndex > 0) {
      setSelectedIndex(selectedIndex - 1);
    }
    if (key.downArrow && selectedIndex < agents.length - 1) {
      setSelectedIndex(selectedIndex + 1);
    }
  });

  if (loading) {
    return (
      <Box>
        <Text color="yellow">Loading agents...</Text>
      </Box>
    );
  }

  if (error) {
    return <Text color="red">Error: {error}</Text>;
  }

  const statusColor = (status: string) => {
    switch (status) {
      case 'running':
        return 'green';
      case 'paused':
        return 'yellow';
      case 'stopped':
        return 'red';
      case 'completed':
        return 'blue';
      case 'failed':
        return 'red';
      default:
        return 'white';
    }
  };

  return (
    <Box flexDirection="column">
      <Text bold underline>
        Agents ({agents.length})
      </Text>

      {agents.length === 0 ? (
        <Box marginTop={1}>
          <Text color="white">No active agents</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {/* Header */}
          <Box>
            <Box width={10}>
              <Text bold color="cyan">STATUS</Text>
            </Box>
            <Box width={20}>
              <Text bold color="cyan">TOPIC</Text>
            </Box>
            <Box width={25}>
              <Text bold color="cyan">MODEL</Text>
            </Box>
            <Box width={10}>
              <Text bold color="cyan">ITER</Text>
            </Box>
            <Box>
              <Text bold color="cyan">ID</Text>
            </Box>
          </Box>

          {/* Agents */}
          {agents.map((agent, index) => (
            <Box
              key={agent.id}
              borderStyle={index === selectedIndex ? 'single' : undefined}
              borderColor={index === selectedIndex ? 'blue' : undefined}
            >
              <Box width={10}>
                <Text color={statusColor(agent.status)}>{agent.status}</Text>
              </Box>
              <Box width={20}>
                <Text color="white">{agent.topic || 'general'}</Text>
              </Box>
              <Box width={25}>
                <Text color="white">{agent.model}</Text>
              </Box>
              <Box width={10}>
                <Text color="white">{agent.iteration}</Text>
              </Box>
              <Box>
                <Text color="white">{agent.id.slice(0, 8)}...</Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="yellow">Up/Down Navigate | Enter: View details | s: Stop agent</Text>
      </Box>
    </Box>
  );
}
