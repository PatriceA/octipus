#!/usr/bin/env bun
import React, { useState } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import { api } from './lib/api.js';

// Views
import { DashboardView } from './views/dashboard.js';
import { AgentsView } from './views/agents.js';
import { ChatView } from './views/chat.js';
import { LogsView } from './views/logs.js';
import { ModelsView } from './views/models.js';
import { PipelinesView } from './views/pipelines.js';
import { SecretsView } from './views/secrets.js';
import { SettingsView } from './views/settings.js';
import { IntegrationsView } from './views/integrations.js';

type ViewType = 'dashboard' | 'agents' | 'chat' | 'logs' | 'models' | 'pipelines' | 'secrets' | 'settings' | 'integrations';

function App() {
  const { exit } = useApp();
  const [currentView, setCurrentView] = useState<ViewType>('dashboard');
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
    }

    // View shortcuts
    if (input === '1') setCurrentView('dashboard');
    if (input === '2') setCurrentView('agents');
    if (input === '3') setCurrentView('chat');
    if (input === '4') setCurrentView('logs');
    if (input === '5') setCurrentView('models');
    if (input === '6') setCurrentView('pipelines');
    if (input === '7') setCurrentView('secrets');
    if (input === '8') setCurrentView('integrations');
    if (input === '9') setCurrentView('settings');
    if (input === 'q') exit();
  });

  const renderView = () => {
    switch (currentView) {
      case 'dashboard':
        return <DashboardView />;
      case 'agents':
        return <AgentsView />;
      case 'chat':
        return <ChatView />;
      case 'logs':
        return <LogsView />;
      case 'models':
        return <ModelsView />;
      case 'pipelines':
        return <PipelinesView />;
      case 'secrets':
        return <SecretsView />;
      case 'integrations':
        return <IntegrationsView />;
      case 'settings':
        return <SettingsView />;
      default:
        return <DashboardView />;
    }
  };

  return (
    <Box flexDirection="column" width="100%">
      {/* Header */}
      <Box
        borderStyle="single"
        borderColor="cyan"
        paddingX={1}
        justifyContent="space-between"
      >
        <Text color="cyan" bold>
          Assistant TUI
        </Text>
        <Text>
          <Text color="yellow">[1]</Text><Text color="white">Dash </Text>
          <Text color="yellow">[2]</Text><Text color="white">Agents </Text>
          <Text color="yellow">[3]</Text><Text color="white">Chat </Text>
          <Text color="yellow">[4]</Text><Text color="white">Logs </Text>
          <Text color="yellow">[5]</Text><Text color="white">Models </Text>
          <Text color="yellow">[6]</Text><Text color="white">Pipes </Text>
          <Text color="yellow">[7]</Text><Text color="white">Secrets </Text>
          <Text color="yellow">[8]</Text><Text color="white">Integ </Text>
          <Text color="yellow">[9]</Text><Text color="white">Settings </Text>
          <Text color="red">[q]</Text><Text color="white">Quit</Text>
        </Text>
      </Box>

      {/* Main Content */}
      <Box flexDirection="column" flexGrow={1} padding={1}>
        {error ? (
          <Box>
            <Text color="red">Error: {error}</Text>
          </Box>
        ) : (
          renderView()
        )}
      </Box>

      {/* Status Bar */}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="green">●</Text>
        <Text color="gray"> Connected | </Text>
        <Text color="gray">View: {currentView}</Text>
      </Box>
    </Box>
  );
}

render(<App />);
