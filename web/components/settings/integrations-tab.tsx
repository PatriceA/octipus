'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Loader2,
  FolderOpen,
  Plus,
  Trash2,
  XCircle,
  RefreshCw,
  Workflow,
  Cable,
  ChevronRight,
} from 'lucide-react';
import { api } from '@/lib/api';
import { OAuthIntegrationsSection } from './oauth-section';
import {
  type SettingItem,
  useSettingActions,
  SettingsGroup,
  SecretsRedirectBanner,
} from './setting-field';

interface WorkspaceConfig {
  rootPath: string;
  additionalPaths: string[];
}

export function IntegrationsTab() {
  return (
    <div className="space-y-8">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Integrations</h2>
      <WorkspaceSection />
      <hr className="border-gray-200 dark:border-gray-700" />
      <CLIIntegrationsSection />
      <hr className="border-gray-200 dark:border-gray-700" />
      <OAuthIntegrationsSection />
      <hr className="border-gray-200 dark:border-gray-700" />
      <IntegrationSettingsSection />
    </div>
  );
}

function WorkspaceSection() {
  const queryClient = useQueryClient();
  const { data: workspace, isLoading: wsLoading } = useQuery({
    queryKey: ['workspace'],
    queryFn: () => api.get<WorkspaceConfig>('/workspace'),
  });
  const [newPath, setNewPath] = useState('');
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleAddPath = async () => {
    if (!newPath.trim() || !workspace) return;
    setValidating(true);
    setError('');

    try {
      const validation = await api.post<{ path: string; valid: boolean }>('/workspace/validate', { path: newPath.trim() });
      if (!validation.valid) {
        setError(`Path "${newPath}" does not exist or is not a directory`);
        setValidating(false);
        return;
      }

      const updated = [...workspace.additionalPaths, validation.path];
      setSaving(true);
      await api.put<WorkspaceConfig>('/workspace', { additionalPaths: updated });
      queryClient.invalidateQueries({ queryKey: ['workspace'] });
      setNewPath('');
    } catch (err) {
      setError((err as Error).message);
    }
    setValidating(false);
    setSaving(false);
  };

  const handleRemovePath = async (index: number) => {
    if (!workspace) return;
    setSaving(true);
    setError('');
    try {
      const updated = workspace.additionalPaths.filter((_, i) => i !== index);
      await api.put<WorkspaceConfig>('/workspace', { additionalPaths: updated });
      queryClient.invalidateQueries({ queryKey: ['workspace'] });
    } catch (err) {
      setError((err as Error).message);
    }
    setSaving(false);
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <FolderOpen className="w-4 h-4 text-gray-500" />
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Workspace Paths</h3>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Directories the agent can access. The root path is set via environment variable.
      </p>

      {/* Root path (read-only) */}
      <div className="mb-3">
        <label className="block text-xs text-gray-500 mb-1">Root Path</label>
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-700 rounded-lg text-sm text-gray-700 dark:text-gray-300 font-mono">
          {wsLoading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-500" />
          ) : (
            workspace?.rootPath || 'Not configured'
          )}
        </div>
      </div>

      {/* Additional paths */}
      <div className="mb-3">
        <label className="block text-xs text-gray-500 mb-1">Additional Paths</label>
        <div className="space-y-2">
          {workspace?.additionalPaths.length === 0 && (
            <p className="text-xs text-gray-500 py-2">No additional paths configured.</p>
          )}
          {workspace?.additionalPaths.map((path, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
              <span className="flex-1 text-sm font-mono text-gray-700 dark:text-gray-300">{path}</span>
              <button
                onClick={() => handleRemovePath(i)}
                disabled={saving}
                className="p-1 text-gray-500 hover:text-red-500 disabled:opacity-50"
                title="Remove path"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Add new path */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAddPath()}
          placeholder="/path/to/directory"
          className="flex-1 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm font-mono"
        />
        <button
          onClick={handleAddPath}
          disabled={!newPath.trim() || validating || saving}
          className="px-3 py-1.5 text-xs bg-primary-800 text-white cursor-pointer rounded-lg hover:bg-primary-900 disabled:opacity-50 flex items-center gap-1"
        >
          {validating || saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
          Add
        </button>
      </div>

      {error && (
        <div className="mt-2 flex items-center gap-1.5 text-sm text-red-600">
          <XCircle className="w-4 h-4" />
          {error}
        </div>
      )}
    </div>
  );
}

function CLIIntegrationsSection() {
  const { data: ghStatus, isLoading: ghLoading, refetch: refetchGh } = useQuery({
    queryKey: ['github-status'],
    queryFn: async () => {
      try {
        const skills = await api.get<{ tools: { id: string; isInitialized: boolean }[] }>('/tools');
        const ghSkill = skills?.tools?.find((s) => s.id === 'github');
        return { available: !!ghSkill, configured: !!ghSkill?.isInitialized };
      } catch {
        return { available: false, configured: false };
      }
    },
  });

  const { data: glStatus, isLoading: glLoading, refetch: refetchGl } = useQuery({
    queryKey: ['gitlab-status'],
    queryFn: async () => {
      try {
        const skills = await api.get<{ tools: { id: string; isInitialized: boolean }[] }>('/tools');
        const glSkill = skills?.tools?.find((s) => s.id === 'gitlab');
        return { available: !!glSkill, configured: !!glSkill?.isInitialized };
      } catch {
        return { available: false, configured: false };
      }
    },
  });

  const cliTools = [
    {
      name: 'GitHub',
      description: 'Manage repos, issues, PRs, and workflows via gh CLI',
      status: ghStatus,
      loading: ghLoading,
      refetch: refetchGh,
      setupHint: 'Install gh CLI and run: gh auth login',
    },
    {
      name: 'GitLab',
      description: 'Manage projects, issues, MRs, and pipelines via glab CLI',
      status: glStatus,
      loading: glLoading,
      refetch: refetchGl,
      setupHint: 'Install glab CLI and run: glab auth login',
    },
  ];

  return (
    <div>
      <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">CLI Integrations</h3>
      <p className="text-xs text-gray-500 mb-3">
        These integrations use locally installed CLI tools. Authenticate via the CLI directly.
      </p>
      <div className="space-y-3">
        {cliTools.map((tool) => (
          <div
            key={tool.name}
            className="flex items-center justify-between p-3 ring-1 ring-gray-200/60 dark:ring-gray-700/60 rounded-xl"
          >
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h4 className="font-medium text-sm text-gray-900 dark:text-gray-100">{tool.name}</h4>
                {tool.loading ? (
                  <Loader2 className="w-3 h-3 animate-spin text-gray-500" />
                ) : (
                  <span
                    className={`px-2 py-0.5 text-xs rounded-full ${
                      tool.status?.configured
                        ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                        : tool.status?.available
                          ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                          : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {tool.status?.configured ? 'Available' : tool.status?.available ? 'Detected' : 'Not found'}
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-0.5">{tool.description}</p>
              {!tool.status?.available && !tool.loading && (
                <p className="text-xs text-gray-500 mt-1 font-mono">{tool.setupHint}</p>
              )}
            </div>
            <button
              onClick={() => tool.refetch()}
              className="p-1.5 text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
              title="Refresh status"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** N8N and MCP settings from the integrations category */
function IntegrationSettingsSection() {
  const { saving, saved, error, handleSave, handleReset } = useSettingActions();

  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings: Record<string, SettingItem[]>; categories: string[] }>('/settings'),
  });

  const integrationSettings = data?.settings?.['integrations'] || [];
  if (integrationSettings.length === 0 && !isLoading) return null;

  // Split into N8N and MCP groups
  const n8nSettings = integrationSettings.filter(s => s.key.startsWith('n8n.') && !s.isSecret);
  const oauthSettings = integrationSettings.filter(s => s.key.startsWith('oauth.') && !s.isSecret);
  const hasSecrets = integrationSettings.some(s => s.isSecret);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      {hasSecrets && <SecretsRedirectBanner />}

      {/* N8N Settings */}
      {n8nSettings.length > 0 && (
        <div className="ring-1 ring-gray-200/60 dark:ring-gray-700/60 rounded-xl overflow-hidden">
          <div className="flex items-center gap-3 px-5 py-4 bg-gray-50/50 dark:bg-gray-800/50 border-b border-gray-200/60 dark:border-gray-700/60">
            <Workflow className="w-5 h-5 text-gray-500 dark:text-gray-400" />
            <div>
              <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">N8N Workflow Automation</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">Connect to your N8N instance for workflow triggers</p>
            </div>
          </div>
          <div className="px-5 py-3">
            <SettingsGroup
              settings={n8nSettings}
              onSave={handleSave}
              onReset={handleReset}
              saving={saving}
              saved={saved}
            />
          </div>
        </div>
      )}

      {/* MCP Servers — managed on the dedicated /mcp page */}
      <a
        href="/mcp"
        className="flex items-center justify-between p-4 ring-1 ring-gray-200/60 dark:ring-gray-700/60 rounded-xl hover:bg-gray-50/50 dark:hover:bg-gray-800/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <Cable className="w-5 h-5 text-gray-500 dark:text-gray-400" />
          <div>
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">MCP Servers</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">Add and manage Model Context Protocol servers</p>
          </div>
        </div>
        <ChevronRight className="w-5 h-5 text-gray-400" />
      </a>

      {/* OAuth Settings (publicUrl) */}
      {oauthSettings.length > 0 && (
        <div className="ring-1 ring-gray-200/60 dark:ring-gray-700/60 rounded-xl overflow-hidden">
          <div className="px-5 py-4 bg-gray-50/50 dark:bg-gray-800/50 border-b border-gray-200/60 dark:border-gray-700/60">
            <h4 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">OAuth</h4>
          </div>
          <div className="px-5 py-3">
            <SettingsGroup
              settings={oauthSettings}
              onSave={handleSave}
              onReset={handleReset}
              saving={saving}
              saved={saved}
            />
          </div>
        </div>
      )}
    </div>
  );
}
