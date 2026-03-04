import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { api } from '../lib/api.js';

interface Model {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  isDefault: boolean;
  isEnabled: boolean;
  topics: string[];
}

export function ModelsView() {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  const fetchModels = async () => {
    try {
      const data = await api.get<{ models: Model[] }>('/models');
      setModels(data?.models || []);
      setLoading(false);
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchModels();
  }, []);

  useInput((input, key) => {
    if (key.upArrow && selected > 0) setSelected(s => s - 1);
    if (key.downArrow && selected < models.length - 1) setSelected(s => s + 1);

    if (input === 'd' && models[selected]) {
      // Set default
      api.post(`/models/${models[selected].id}/default`).then(() => {
        setMessage(`Set "${models[selected].name}" as default`);
        fetchModels();
        setTimeout(() => setMessage(null), 3000);
      }).catch(() => setMessage('Failed to set default'));
    }

    if (input === 't' && models[selected]) {
      // Toggle enable/disable
      const model = models[selected];
      api.put(`/models/${model.id}`, { isEnabled: !model.isEnabled }).then(() => {
        setMessage(`${model.isEnabled ? 'Disabled' : 'Enabled'} "${model.name}"`);
        fetchModels();
        setTimeout(() => setMessage(null), 3000);
      }).catch(() => setMessage('Failed to toggle'));
    }

    if (input === 'r') {
      setLoading(true);
      fetchModels();
    }
  });

  if (loading) {
    return <Text color="yellow">Loading models...</Text>;
  }

  if (error) {
    return <Text color="red">Error: {error}</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text bold underline>Models</Text>
      <Text color="yellow">↑↓ navigate | d = set default | t = toggle | r = refresh</Text>
      {message && <Text color="cyan">{message}</Text>}

      <Box marginTop={1} flexDirection="column">
        {models.length === 0 ? (
          <Text color="white">No models configured</Text>
        ) : (
          models.map((model, i) => (
            <Box key={model.id}>
              <Text color={i === selected ? 'cyan' : undefined}>
                {i === selected ? '▸ ' : '  '}
              </Text>
              <Text color={model.isEnabled ? 'white' : 'red'} bold={i === selected} dimColor={!model.isEnabled}>
                {model.name}
              </Text>
              <Text color="white"> ({model.provider}/{model.modelId}) </Text>
              <Text color={model.isEnabled ? 'green' : 'red'}>●</Text>
              {model.isDefault && <Text color="yellow"> ★</Text>}
              {!model.isEnabled && <Text color="red"> [disabled]</Text>}
              {model.topics.length > 0 && (
                <Text color="cyan"> [{model.topics.join(', ')}]</Text>
              )}
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
