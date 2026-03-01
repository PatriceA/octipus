import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { api } from '../lib/api.js';

interface PipelineTemplate {
  id: string;
  name: string;
  description?: string;
  steps: Array<{ name: string; topic: string; requiresApproval?: boolean }>;
}

interface Pipeline {
  id: string;
  title: string;
  type: string;
  status: string;
  currentStageIndex: number;
  createdAt: string;
}

type Tab = 'templates' | 'runs';

export function PipelinesView() {
  const [tab, setTab] = useState<Tab>('templates');
  const [templates, setTemplates] = useState<PipelineTemplate[]>([]);
  const [runs, setRuns] = useState<Pipeline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    const fetch = async () => {
      try {
        if (tab === 'templates') {
          const data = await api.get<{ templates: PipelineTemplate[] }>('/pipelines/templates');
          setTemplates(data?.templates || []);
        } else {
          const data = await api.get<{ pipelines: Pipeline[] }>('/pipelines');
          setRuns(data?.pipelines || []);
        }
        setLoading(false);
      } catch (err) {
        setError((err as Error).message);
        setLoading(false);
      }
    };
    setLoading(true);
    setSelected(0);
    fetch();
  }, [tab]);

  useInput((input, key) => {
    const items = tab === 'templates' ? templates : runs;
    if (key.upArrow && selected > 0) setSelected(s => s - 1);
    if (key.downArrow && selected < items.length - 1) setSelected(s => s + 1);
    if (key.tab || input === '\t') setTab(t => t === 'templates' ? 'runs' : 'templates');
    if (input === 'r') {
      setLoading(true);
      setTab(tab); // re-trigger effect
    }
  });

  if (loading) {
    return <Text color="yellow">Loading...</Text>;
  }

  if (error) {
    return <Text color="red">Error: {error}</Text>;
  }

  const statusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'green';
      case 'running': return 'cyan';
      case 'awaiting_approval': return 'yellow';
      case 'failed': return 'red';
      default: return 'gray';
    }
  };

  return (
    <Box flexDirection="column">
      <Text bold underline>Pipelines</Text>
      <Box>
        <Text color={tab === 'templates' ? 'cyan' : 'gray'} bold={tab === 'templates'}>
          [Templates]
        </Text>
        <Text> </Text>
        <Text color={tab === 'runs' ? 'cyan' : 'gray'} bold={tab === 'runs'}>
          [Runs]
        </Text>
        <Text color="gray"> | Tab = switch | ↑↓ navigate | r = refresh</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {tab === 'templates' ? (
          templates.length === 0 ? (
            <Text color="gray">No templates. Create one in the web UI.</Text>
          ) : (
            templates.map((t, i) => (
              <Box key={t.id} flexDirection="column">
                <Box>
                  <Text color={i === selected ? 'cyan' : undefined}>
                    {i === selected ? '▸ ' : '  '}
                  </Text>
                  <Text bold={i === selected}>{t.name}</Text>
                  <Text color="gray"> ({t.steps.length} steps)</Text>
                </Box>
                {i === selected && t.steps.length > 0 && (
                  <Box marginLeft={4} flexDirection="column">
                    {t.steps.map((step, si) => (
                      <Box key={si}>
                        <Text color="gray">{si + 1}. </Text>
                        <Text>{step.name}</Text>
                        <Text color="gray"> [{step.topic}]</Text>
                        {step.requiresApproval && <Text color="yellow"> ⚑</Text>}
                      </Box>
                    ))}
                  </Box>
                )}
              </Box>
            ))
          )
        ) : (
          runs.length === 0 ? (
            <Text color="gray">No pipeline runs yet.</Text>
          ) : (
            runs.map((run, i) => (
              <Box key={run.id}>
                <Text color={i === selected ? 'cyan' : undefined}>
                  {i === selected ? '▸ ' : '  '}
                </Text>
                <Text bold={i === selected}>{run.title}</Text>
                <Text color={statusColor(run.status)}> [{run.status}]</Text>
                <Text color="gray"> stage {run.currentStageIndex + 1}</Text>
              </Box>
            ))
          )
        )}
      </Box>
    </Box>
  );
}
