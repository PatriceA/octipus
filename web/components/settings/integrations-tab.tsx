'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Cable,
  ChevronRight,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Workflow,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { OAuthIntegrationsSection } from './oauth-section';
import {
  SecretsRedirectBanner,
  type SettingItem,
  SettingsGroup,
  useSettingActions,
} from './setting-field';

interface WorkspaceConfig {
  rootPath: string;
  additionalPaths: string[];
}

export function IntegrationsTab() {
  return (
    <div className="space-y-8">
      <h2 className="text-lg font-extrabold tracking-tighter text-on-surface">Integrations</h2>
      <WorkspaceSection />
      <hr className="border-outline-variant/10" />
      <CLIIntegrationsSection />
      <hr className="border-outline-variant/10" />
      <OAuthIntegrationsSection />
      <hr className="border-outline-variant/10" />
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
        <FolderOpen className="w-4 h-4 text-on-surface-variant" />
        <h3 className="text-xs font-bold text-on-surface-variant uppercase">Workspace Folders</h3>
      </div>
      <p className="text-xs text-on-surface-variant mb-3">
        Filesystem directories the agent can read and write. These are separate from the
        organization workspace selector in the top-right header (which scopes data, not files).
        The root path is set via the <code className="px-1 py-0.5 bg-surface-container-high rounded text-[10px]">OCTIPUS_WORKSPACE_ROOT</code> environment variable.
      </p>
      <p className="text-xs text-on-surface-variant mb-3">
        Add a parent folder (e.g. your repos directory) and its subdirectories will appear in the
        dev-session project picker.
      </p>

      {/* Root path (read-only) */}
      <div className="mb-3">
        <label className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">Root Path</label>
        <div className="flex items-center gap-2 bg-surface-container-high border border-outline-variant rounded-md py-3 px-4 text-sm text-on-surface font-mono">
          {wsLoading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-on-surface-variant" />
          ) : (
            workspace?.rootPath || 'Not configured'
          )}
        </div>
      </div>

      {/* Additional paths */}
      <div className="mb-3">
        <label className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">Additional Paths</label>
        <div className="space-y-2">
          {workspace?.additionalPaths.length === 0 && (
            <p className="text-xs text-on-surface-variant py-2">No additional paths configured.</p>
          )}
          {workspace?.additionalPaths.map((path, i) => (
            <div key={i} className="flex items-center gap-2 bg-surface-container-low rounded-lg py-3 px-4">
              <span className="flex-1 text-sm font-mono text-on-surface">{path}</span>
              <button
                onClick={() => handleRemovePath(i)}
                disabled={saving}
                className="p-1 text-on-surface-variant hover:text-error disabled:opacity-50"
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
          className="flex-1 bg-surface-container-high border border-outline-variant rounded-md py-3 px-4 text-on-surface text-sm font-mono focus:ring-1 focus:ring-primary"
        />
        <button
          onClick={handleAddPath}
          disabled={!newPath.trim() || validating || saving}
          className="px-3 py-1.5 text-xs bg-primary text-[#0e0e0e] cursor-pointer rounded-lg hover:bg-primary-container disabled:opacity-50 flex items-center gap-1"
        >
          {validating || saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
          Add
        </button>
      </div>

      {error && (
        <div className="mt-2 flex items-center gap-1.5 text-sm text-error">
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
        const skills = await api.get<{ tools: { id: string; status: string; isInitialized: boolean }[] }>('/tools');
        const ghSkill = skills?.tools?.find((s) => s.id === 'github');
        return { available: ghSkill?.status === 'active', configured: !!ghSkill?.isInitialized };
      } catch {
        return { available: false, configured: false };
      }
    },
  });

  const { data: glStatus, isLoading: glLoading, refetch: refetchGl } = useQuery({
    queryKey: ['gitlab-status'],
    queryFn: async () => {
      try {
        const skills = await api.get<{ tools: { id: string; status: string; isInitialized: boolean }[] }>('/tools');
        const glSkill = skills?.tools?.find((s) => s.id === 'gitlab');
        return { available: glSkill?.status === 'active', configured: !!glSkill?.isInitialized };
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
      <h3 className="text-xs font-bold text-on-surface-variant uppercase mb-1">CLI Integrations</h3>
      <p className="text-xs text-on-surface-variant mb-3">
        These integrations use locally installed CLI tools. Authenticate via the CLI directly.
      </p>
      <div className="space-y-3">
        {cliTools.map((tool) => (
          <div
            key={tool.name}
            className="flex items-center justify-between p-3 bg-surface-container-low rounded-xs"
          >
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h4 className="font-medium text-sm text-on-surface">{tool.name}</h4>
                {tool.loading ? (
                  <Loader2 className="w-3 h-3 animate-spin text-on-surface-variant" />
                ) : (
                  <span
                    className={`px-2 py-0.5 text-xs rounded-full ${
                      tool.status?.configured
                        ? 'bg-tertiary-container/60 text-tertiary'
                        : tool.status?.available
                          ? 'bg-amber-900/30 text-warning'
                          : 'bg-surface-container-high text-on-surface-variant'
                    }`}
                  >
                    {tool.status?.configured ? 'Available' : tool.status?.available ? 'Detected' : 'Not found'}
                  </span>
                )}
              </div>
              <p className="text-xs text-on-surface-variant mt-0.5">{tool.description}</p>
              {!tool.status?.available && !tool.loading && (
                <p className="text-xs text-on-surface-variant mt-1 font-mono">{tool.setupHint}</p>
              )}
            </div>
            <button
              onClick={() => tool.refetch()}
              className="p-1.5 text-on-surface-variant hover:text-on-surface"
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
        <Loader2 className="w-5 h-5 animate-spin text-on-surface-variant" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-3 bg-error-dim/10 border border-error-dim/20 rounded-lg">
          <p className="text-sm text-error">{error}</p>
        </div>
      )}

      {hasSecrets && <SecretsRedirectBanner />}

      {/* N8N Settings */}
      {n8nSettings.length > 0 && (
        <div className="bg-surface-container-low rounded-xs overflow-hidden">
          <div className="flex items-center gap-3 px-5 py-4 border-b border-outline-variant/10">
            <Workflow className="w-5 h-5 text-on-surface-variant" />
            <div>
              <h3 className="text-base font-semibold text-on-surface">N8N Workflow Automation</h3>
              <p className="text-xs text-on-surface-variant">Connect to your N8N instance for workflow triggers</p>
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
        className="flex items-center justify-between p-4 bg-surface-container-low rounded-xs hover:bg-surface-container-high transition-colors"
      >
        <div className="flex items-center gap-3">
          <Cable className="w-5 h-5 text-on-surface-variant" />
          <div>
            <h3 className="text-base font-semibold text-on-surface">MCP Servers</h3>
            <p className="text-xs text-on-surface-variant">Add and manage Model Context Protocol servers</p>
          </div>
        </div>
        <ChevronRight className="w-5 h-5 text-on-surface-variant" />
      </a>

      {/* OAuth Settings (publicUrl) */}
      {oauthSettings.length > 0 && (
        <div className="bg-surface-container-low rounded-xs overflow-hidden">
          <div className="px-5 py-4 border-b border-outline-variant/10">
            <h4 className="text-xs font-bold text-on-surface-variant uppercase tracking-wider">OAuth</h4>
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
