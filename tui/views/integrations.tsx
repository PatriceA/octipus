import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { api } from '../lib/api.js';

interface WorkspaceConfig {
  rootPath: string;
  additionalPaths: string[];
}

interface OAuthStatus {
  connected: boolean;
  provider: string;
  email?: string;
}

interface SkillInfo {
  name: string;
  enabled: boolean;
}

type Section = 'workspace' | 'cli' | 'oauth';

export function IntegrationsView() {
  const [section, setSection] = useState<Section>('workspace');
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [googleStatus, setGoogleStatus] = useState<OAuthStatus | null>(null);
  const [microsoftStatus, setMicrosoftStatus] = useState<OAuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState(0);
  const [inputMode, setInputMode] = useState(false);
  const [inputBuffer, setInputBuffer] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const sections: Section[] = ['workspace', 'cli', 'oauth'];

  const fetchData = async () => {
    try {
      const [ws, sk, gs, ms] = await Promise.allSettled([
        api.get<WorkspaceConfig>('/workspace'),
        api.get<{ tools: SkillInfo[] }>('/tools'),
        api.get<OAuthStatus>('/auth/oauth/google/status'),
        api.get<OAuthStatus>('/auth/oauth/microsoft/status'),
      ]);

      if (ws.status === 'fulfilled') setWorkspace(ws.value);
      if (sk.status === 'fulfilled') setSkills(sk.value?.tools || []);
      if (gs.status === 'fulfilled') setGoogleStatus(gs.value);
      else setGoogleStatus({ connected: false, provider: 'google' });
      if (ms.status === 'fulfilled') setMicrosoftStatus(ms.value);
      else setMicrosoftStatus({ connected: false, provider: 'microsoft' });

      setLoading(false);
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  useInput((input, key) => {
    if (inputMode) {
      if (key.return) {
        handleAddPath(inputBuffer);
        setInputMode(false);
        setInputBuffer('');
        return;
      }
      if (key.escape) {
        setInputMode(false);
        setInputBuffer('');
        return;
      }
      if (key.backspace || key.delete) {
        setInputBuffer((b) => b.slice(0, -1));
        return;
      }
      if (input && !key.ctrl) {
        setInputBuffer((b) => b + input);
      }
      return;
    }

    // Section navigation
    if (key.tab || input === 'n') {
      const idx = sections.indexOf(section);
      setSection(sections[(idx + 1) % sections.length]);
      setSelectedPath(0);
    }
    if (input === 'N') {
      const idx = sections.indexOf(section);
      setSection(sections[(idx - 1 + sections.length) % sections.length]);
      setSelectedPath(0);
    }

    // Workspace path navigation
    if (section === 'workspace') {
      if (key.upArrow) setSelectedPath((p) => Math.max(0, p - 1));
      if (key.downArrow && workspace) setSelectedPath((p) => Math.min(workspace.additionalPaths.length - 1, p));
      if (input === 'a') {
        setInputMode(true);
        setInputBuffer('');
        setMessage(null);
      }
      if (input === 'x' && workspace && workspace.additionalPaths.length > 0) {
        handleRemovePath(selectedPath);
      }
    }

    if (input === 'r') fetchData();
  });

  const handleAddPath = async (path: string) => {
    if (!path.trim() || !workspace) return;
    setMessage(null);
    try {
      const validation = await api.post<{ path: string; valid: boolean }>('/workspace/validate', { path: path.trim() });
      if (!validation.valid) {
        setMessage(`Invalid: "${path}" does not exist or is not a directory`);
        return;
      }
      const updated = [...workspace.additionalPaths, validation.path];
      const result = await api.put<WorkspaceConfig>('/workspace', { additionalPaths: updated });
      setWorkspace(result);
      setMessage(`Added: ${validation.path}`);
    } catch (err) {
      setMessage(`Error: ${(err as Error).message}`);
    }
  };

  const handleRemovePath = async (index: number) => {
    if (!workspace) return;
    setMessage(null);
    try {
      const removed = workspace.additionalPaths[index];
      const updated = workspace.additionalPaths.filter((_, i) => i !== index);
      const result = await api.put<WorkspaceConfig>('/workspace', { additionalPaths: updated });
      setWorkspace(result);
      setSelectedPath(Math.max(0, selectedPath - 1));
      setMessage(`Removed: ${removed}`);
    } catch (err) {
      setMessage(`Error: ${(err as Error).message}`);
    }
  };

  if (loading) {
    return <Text color="yellow">Loading integrations...</Text>;
  }

  if (error) {
    return <Text color="red">Error: {error}</Text>;
  }

  const ghSkill = skills.find((s) => s.name === 'github');
  const glSkill = skills.find((s) => s.name === 'gitlab');

  return (
    <Box flexDirection="column">
      <Text bold underline>Integrations</Text>

      {/* Section tabs */}
      <Box marginTop={1} gap={2}>
        {sections.map((s) => (
          <Text key={s} color={section === s ? 'cyan' : 'white'} bold={section === s}>
            [{section === s ? '*' : ' '}] {s === 'workspace' ? 'Workspace' : s === 'cli' ? 'CLI Tools' : 'OAuth'}
          </Text>
        ))}
        <Text color="yellow"> [Tab/n] switch</Text>
      </Box>

      {/* Workspace section */}
      {section === 'workspace' && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Workspace Paths</Text>
          <Box marginTop={1}>
            <Text color="white">Root: </Text>
            <Text color="cyan">{workspace?.rootPath || 'Not set'}</Text>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text bold>Additional Paths:</Text>
            {workspace?.additionalPaths.length === 0 ? (
              <Text color="white">  (none)</Text>
            ) : (
              workspace?.additionalPaths.map((p, i) => (
                <Box key={i}>
                  <Text color={i === selectedPath ? 'cyan' : 'white'}>
                    {i === selectedPath ? ' > ' : '   '}
                    {p}
                  </Text>
                </Box>
              ))
            )}
          </Box>

          {inputMode ? (
            <Box marginTop={1}>
              <Text color="yellow">Path: </Text>
              <Text>{inputBuffer}</Text>
              <Text color="yellow">_</Text>
            </Box>
          ) : (
            <Box marginTop={1}>
              <Text color="yellow">[a] Add path  [x] Remove selected  [r] Refresh</Text>
            </Box>
          )}

          {message && (
            <Box marginTop={1}>
              <Text color={message.startsWith('Error') || message.startsWith('Invalid') ? 'red' : 'green'}>
                {message}
              </Text>
            </Box>
          )}
        </Box>
      )}

      {/* CLI section */}
      {section === 'cli' && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>CLI Integrations</Text>
          <Text color="white">These use locally installed CLI tools.</Text>

          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text>GitHub (gh):  </Text>
              <Text color={ghSkill?.enabled ? 'green' : 'yellow'}>
                {ghSkill?.enabled ? 'Available' : 'Not configured'}
              </Text>
            </Box>
            {!ghSkill?.enabled && (
              <Text color="white">  Install gh CLI and run: gh auth login</Text>
            )}
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text>GitLab (glab): </Text>
              <Text color={glSkill?.enabled ? 'green' : 'yellow'}>
                {glSkill?.enabled ? 'Available' : 'Not configured'}
              </Text>
            </Box>
            {!glSkill?.enabled && (
              <Text color="white">  Install glab CLI and run: glab auth login</Text>
            )}
          </Box>

          <Box marginTop={1}>
            <Text color="yellow">[r] Refresh</Text>
          </Box>
        </Box>
      )}

      {/* OAuth section */}
      {section === 'oauth' && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>OAuth Integrations</Text>
          <Text color="white">Connect via the Web UI to authorize access.</Text>

          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text>Google Workspace: </Text>
              <Text color={googleStatus?.connected ? 'green' : 'yellow'}>
                {googleStatus?.connected ? 'Connected' : 'Not connected'}
              </Text>
            </Box>
            {googleStatus?.connected && googleStatus.email && (
              <Text color="white">  Account: {googleStatus.email}</Text>
            )}
            <Text color="white">  Gmail, Calendar, Drive, Docs, Sheets, Contacts, Tasks</Text>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text>Microsoft 365:   </Text>
              <Text color={microsoftStatus?.connected ? 'green' : 'yellow'}>
                {microsoftStatus?.connected ? 'Connected' : 'Not connected'}
              </Text>
            </Box>
            {microsoftStatus?.connected && microsoftStatus.email && (
              <Text color="white">  Account: {microsoftStatus.email}</Text>
            )}
            <Text color="white">  Outlook, Calendar, OneDrive, To Do, Contacts</Text>
          </Box>

          <Box marginTop={1}>
            <Text color="yellow">Use the Web UI to connect/disconnect OAuth providers.</Text>
          </Box>

          <Box marginTop={1}>
            <Text color="yellow">[r] Refresh</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
