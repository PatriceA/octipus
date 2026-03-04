import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { api } from '../lib/api.js';

interface Credential {
  id: string;
  name: string;
  credentialType?: string;
  createdAt: string;
  updatedAt: string;
}

export function SecretsView() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  const fetchCredentials = async () => {
    try {
      const data = await api.get<{ credentials: Credential[] }>('/vault');
      setCredentials(data?.credentials || []);
      setLoading(false);
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCredentials();
  }, []);

  useInput((input, key) => {
    if (key.upArrow && selected > 0) setSelected(s => s - 1);
    if (key.downArrow && selected < credentials.length - 1) setSelected(s => s + 1);

    if (input === 'x' && credentials[selected]) {
      api.delete(`/vault/${credentials[selected].id}`).then(() => {
        setMessage(`Deleted "${credentials[selected].name}"`);
        fetchCredentials();
        setTimeout(() => setMessage(null), 3000);
      }).catch(() => setMessage('Failed to delete'));
    }

    if (input === 'r') {
      setLoading(true);
      fetchCredentials();
    }
  });

  if (loading) {
    return <Text color="yellow">Loading secrets...</Text>;
  }

  if (error) {
    return <Text color="red">Error: {error}</Text>;
  }

  const typeColor = (type?: string) => {
    switch (type) {
      case 'oauth_token': return 'green';
      case 'api_key': return 'cyan';
      case 'password': return 'yellow';
      default: return 'white';
    }
  };

  return (
    <Box flexDirection="column">
      <Text bold underline>Secrets Vault</Text>
      <Text color="yellow">Up/Down navigate | x = delete | r = refresh</Text>
      <Text color="white">Use the web UI to add new secrets.</Text>
      {message && <Text color="cyan">{message}</Text>}

      <Box marginTop={1} flexDirection="column">
        {credentials.length === 0 ? (
          <Text color="white">No secrets stored.</Text>
        ) : (
          credentials.map((cred, i) => (
            <Box key={cred.id}>
              <Text color={i === selected ? 'cyan' : undefined}>
                {i === selected ? '> ' : '  '}
              </Text>
              <Text bold={i === selected} color="white">{cred.name}</Text>
              {cred.credentialType && (
                <Text color={typeColor(cred.credentialType)}> [{cred.credentialType}]</Text>
              )}
              <Text color="white"> (added {new Date(cred.createdAt).toLocaleDateString()})</Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
