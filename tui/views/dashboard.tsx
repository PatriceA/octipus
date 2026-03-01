import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { api } from '../lib/api.js';

interface HealthData {
  status: string;
  uptime?: number;
  agents?: { total: number; running: number };
  health?: {
    database: { status: string; latency?: number };
    redis: { status: string; latency?: number };
    models: { status: string };
  };
}

export function DashboardView() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const data = await api.get<HealthData>('/health/detailed');
        setHealth(data);
        setLoading(false);
      } catch (err) {
        setError((err as Error).message);
        setLoading(false);
      }
    };

    fetchHealth();
    const interval = setInterval(fetchHealth, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <Box>
        <Text color="yellow">⠋ Loading...</Text>
      </Box>
    );
  }

  if (error) {
    return <Text color="red">Error: {error}</Text>;
  }

  const formatUptime = (ms?: number) => {
    if (!ms) return 'N/A';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  const statusColor = (status?: string) => {
    switch (status) {
      case 'healthy':
      case 'ok':
        return 'green';
      case 'degraded':
        return 'yellow';
      default:
        return 'red';
    }
  };

  return (
    <Box flexDirection="column">
      <Text bold underline>
        System Status
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text>Status: </Text>
          <Text color={statusColor(health?.status)}>{health?.status || 'unknown'}</Text>
        </Box>
        <Box>
          <Text>Uptime: </Text>
          <Text color="cyan">{formatUptime(health?.uptime)}</Text>
        </Box>
      </Box>

      <Text bold underline>
        Agents
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text>Total: </Text>
          <Text color="cyan">{health?.agents?.total || 0}</Text>
        </Box>
        <Box>
          <Text>Running: </Text>
          <Text color="green">{health?.agents?.running || 0}</Text>
        </Box>
      </Box>

      <Text bold underline>
        Services
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text>Database: </Text>
          <Text color={statusColor(health?.health?.database?.status)}>
            {health?.health?.database?.status || 'unknown'}
          </Text>
          {health?.health?.database?.latency && (
            <Text color="gray"> ({health.health.database.latency}ms)</Text>
          )}
        </Box>
        <Box>
          <Text>Redis: </Text>
          <Text color={statusColor(health?.health?.redis?.status)}>
            {health?.health?.redis?.status || 'unknown'}
          </Text>
          {health?.health?.redis?.latency && (
            <Text color="gray"> ({health.health.redis.latency}ms)</Text>
          )}
        </Box>
        <Box>
          <Text>Models: </Text>
          <Text color={statusColor(health?.health?.models?.status)}>
            {health?.health?.models?.status || 'unknown'}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
