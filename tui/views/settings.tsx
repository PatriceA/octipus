import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { api } from '../lib/api.js';

interface UserInfo {
  user: {
    id: string;
    username: string;
    isAdmin: boolean;
    totpEnabled?: boolean;
    createdAt: string;
  };
}

export function SettingsView() {
  const [user, setUser] = useState<UserInfo['user'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetch = async () => {
      try {
        const data = await api.get<UserInfo>('/auth/me');
        setUser(data?.user || null);
        setLoading(false);
      } catch (err) {
        setError((err as Error).message);
        setLoading(false);
      }
    };
    fetch();
  }, []);

  if (loading) {
    return <Text color="yellow">Loading settings...</Text>;
  }

  if (error) {
    return <Text color="red">Error: {error}</Text>;
  }

  if (!user) {
    return <Text color="red">Not authenticated. Login required.</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text bold underline>Settings</Text>

      <Box marginTop={1} flexDirection="column">
        <Text bold>User Info</Text>
        <Box>
          <Text>Username: </Text>
          <Text color="cyan">{user.username}</Text>
        </Box>
        <Box>
          <Text>Role: </Text>
          <Text color={user.isAdmin ? 'yellow' : 'white'}>
            {user.isAdmin ? 'Administrator' : 'User'}
          </Text>
        </Box>
        <Box>
          <Text>User ID: </Text>
          <Text color="gray">{user.id}</Text>
        </Box>
        <Box>
          <Text>Created: </Text>
          <Text color="gray">{new Date(user.createdAt).toLocaleDateString()}</Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Security</Text>
        <Box>
          <Text>2FA (TOTP): </Text>
          <Text color={user.totpEnabled ? 'green' : 'gray'}>
            {user.totpEnabled ? 'Enabled' : 'Disabled'}
          </Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color="gray">Use the web UI for full settings management.</Text>
      </Box>
    </Box>
  );
}
