'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Cable,
  Check,
  ChevronDown,
  ChevronRight,
  HelpCircle,
  Loader2,
  RotateCcw,
  Search,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import { useCallback, useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface ToolPermission {
  action: string;
  description: string;
  defaultLevel: 'ALLOW' | 'ASK' | 'DENY';
  dangerous?: boolean;
}

interface ToolFunction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  returns: string;
}

interface ToolModule {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  isInitialized: boolean;
  status?: 'active' | 'inactive' | 'degraded';
  statusReason?: string;
  permissions: ToolPermission[];
  tools: ToolFunction[];
}

interface UserPermission {
  toolId: string;
  action: string;
  level: 'ALLOW' | 'ASK' | 'DENY';
  reason?: string;
}

interface MCPTool {
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type PermissionLevel = 'ALLOW' | 'ASK' | 'DENY';

const LEVEL_STYLES: Record<PermissionLevel, { active: string; label: string; icon: typeof Check }> = {
  ALLOW: { active: 'bg-green-600 text-on-surface', label: 'Allow', icon: Check },
  ASK: { active: 'bg-warning text-on-surface', label: 'Ask', icon: HelpCircle },
  DENY: { active: 'bg-red-600 text-on-surface', label: 'Deny', icon: X },
};

function PermissionToggle({
  currentLevel,
  defaultLevel,
  onChange,
  onReset,
  isOverride,
}: {
  currentLevel: PermissionLevel;
  defaultLevel: PermissionLevel;
  onChange: (level: PermissionLevel) => void;
  onReset: () => void;
  isOverride: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      {(['ALLOW', 'ASK', 'DENY'] as PermissionLevel[]).map((level) => {
        const active = currentLevel === level;
        const { icon: Icon, active: activeStyle } = LEVEL_STYLES[level];
        return (
          <button
            key={level}
            onClick={() => onChange(level)}
            className={cn(
              'px-1.5 py-0.5 rounded text-xs font-medium cursor-pointer flex items-center gap-0.5 transition-colors',
              active
                ? activeStyle
                : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-high'
            )}
            title={level}
          >
            <Icon className="w-3 h-3" />
          </button>
        );
      })}
      {isOverride && (
        <button
          onClick={onReset}
          className="p-0.5 text-on-surface-variant hover:text-on-surface cursor-pointer"
          title={`Reset to default (${defaultLevel})`}
        >
          <RotateCcw className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

function ToolModuleCard({
  module,
  userPermissions,
  roleAccess,
  onPermissionChange,
  onPermissionReset,
}: {
  module: ToolModule;
  userPermissions: UserPermission[];
  /** Agent roles whose toolIds include this module — i.e. who can actually call it. */
  roleAccess: string[];
  onPermissionChange: (toolId: string, action: string, level: PermissionLevel) => void;
  onPermissionReset: (toolId: string, action: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const getEffectiveLevel = (perm: ToolPermission): PermissionLevel => {
    const override = userPermissions.find((p) => p.toolId === module.id && p.action === perm.action);
    return override?.level || perm.defaultLevel;
  };

  const hasOverride = (perm: ToolPermission): boolean => {
    return userPermissions.some((p) => p.toolId === module.id && p.action === perm.action);
  };

  const overrideCount = module.permissions.filter((p) => hasOverride(p)).length;

  // Build a unified list: each permission matched with its corresponding tool function
  const capabilities = module.permissions.map((perm) => {
    const matchingTool = module.tools.find(
      (t) => t.name === perm.action || t.name.endsWith(perm.action)
    );
    return { permission: perm, tool: matchingTool };
  });

  // Tools without a matching permission
  const unmatchedTools = module.tools.filter(
    (t) => !module.permissions.some((p) => p.action === t.name || t.name.endsWith(p.action))
  );

  return (
    <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 flex items-center justify-between text-left cursor-pointer"
      >
        <div className="flex items-center gap-3">
          <div className="text-on-surface-variant">
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </div>
          <Wrench className={cn('w-5 h-5', module.status === 'active' ? 'text-primary' : module.status === 'degraded' ? 'text-warning' : 'text-on-surface-variant')} />
          <div>
            <h3 className="font-medium text-on-surface">{module.name}</h3>
            <p className="text-xs text-on-surface-variant mt-0.5">{module.description}</p>
            {module.status !== 'active' && module.statusReason && (
              <p className={cn('text-xs mt-0.5', module.status === 'degraded' ? 'text-warning' : 'text-error')}>{module.statusReason}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-on-surface-variant">
            {module.tools.length + module.permissions.length > 0
              ? `${Math.max(module.tools.length, module.permissions.length)} capabilities`
              : 'no capabilities'}
          </span>
          {overrideCount > 0 && (
            <span className="px-1.5 py-0.5 text-xs rounded-full bg-blue-900/30 text-primary">
              {overrideCount} custom
            </span>
          )}
          <span
            className={cn(
              'px-1.5 py-0.5 text-xs rounded-full flex items-center gap-1',
              roleAccess.length > 0
                ? 'bg-surface-container-high text-on-surface-variant'
                : 'bg-amber-900/30 text-warning'
            )}
            title={
              roleAccess.length > 0
                ? `Agent roles that can use this tool: ${roleAccess.join(', ')}`
                : 'No agent role grants this tool — agents cannot call it. Add its id to a role’s toolIds.'
            }
          >
            <Users className="w-3 h-3" />
            {roleAccess.length > 0 ? `${roleAccess.length} roles` : 'unused'}
          </span>
          <span className="text-xs text-on-surface-variant">v{module.version}</span>
          <span
            className={cn(
              'px-2 py-0.5 text-xs rounded-full',
              module.status === 'active'
                ? 'bg-green-900/30 text-tertiary'
                : module.status === 'degraded'
                ? 'bg-amber-900/30 text-warning'
                : 'bg-surface-container-high text-on-surface-variant'
            )}
            title={module.statusReason}
          >
            {module.status === 'active' ? 'Active' : module.status === 'degraded' ? 'Degraded' : 'Inactive'}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-outline-variant/10 p-4 space-y-1.5">
          {/* Which agent roles / topics can use this tool — the QA ask: the
              tool was visible but not which topics could reach it. */}
          <div className="flex items-start gap-2 pb-2 mb-1.5 border-b border-outline-variant/10">
            <Users className="w-4 h-4 text-on-surface-variant mt-0.5 shrink-0" />
            {roleAccess.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                <span className="text-xs text-on-surface-variant mr-1">Available to roles:</span>
                {roleAccess.map((role) => (
                  <span
                    key={role}
                    className="px-1.5 py-0.5 text-[10px] rounded bg-surface-container-high text-on-surface/80 font-mono"
                  >
                    {role}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-warning">
                Not assigned to any agent role — no agent can call this tool. Add{' '}
                <span className="font-mono">{module.id}</span> to a role’s <span className="font-mono">toolIds</span>.
              </p>
            )}
          </div>

          {/* Capabilities with inline permissions */}
          {capabilities.map(({ permission, tool }) => {
            const effectiveLevel = getEffectiveLevel(permission);
            const isOverride = hasOverride(permission);

            return (
              <div
                key={permission.action}
                className={cn(
                  'flex items-center justify-between py-2 px-3 rounded-lg',
                  isOverride
                    ? 'bg-blue-900/10 ring-1 ring-blue-800'
                    : 'bg-surface-container-low'
                )}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono text-on-surface/90">
                      {permission.action}
                    </span>
                    {permission.dangerous && (
                      <span className="px-1 py-0.5 bg-red-900/30 text-error text-[10px] rounded font-medium">
                        dangerous
                      </span>
                    )}
                    {isOverride && (
                      <span className="text-[10px] text-primary">default: {permission.defaultLevel}</span>
                    )}
                  </div>
                  <p className="text-xs text-on-surface-variant mt-0.5">
                    {tool?.description || permission.description}
                  </p>
                </div>
                <PermissionToggle
                  currentLevel={effectiveLevel}
                  defaultLevel={permission.defaultLevel}
                  onChange={(level) => onPermissionChange(module.id, permission.action, level)}
                  onReset={() => onPermissionReset(module.id, permission.action)}
                  isOverride={isOverride}
                />
              </div>
            );
          })}

          {/* Tools without explicit permissions (shown as info-only) */}
          {unmatchedTools.map((tool) => (
            <div key={tool.name} className="flex items-center justify-between py-2 px-3 rounded-lg bg-surface-container-low">
              <div className="flex-1 min-w-0">
                <span className="text-sm font-mono text-on-surface/90">{tool.name}</span>
                <p className="text-xs text-on-surface-variant mt-0.5">{tool.description}</p>
              </div>
              <span className="text-xs text-on-surface-variant italic">inherited</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ToolsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [reloading, setReloading] = useState(false);
  const [reloadMessage, setReloadMessage] = useState('');
  const queryClient = useQueryClient();

  const handleReload = useCallback(async () => {
    setReloading(true);
    setReloadMessage('');
    try {
      const result = await api.post<{ reloaded: boolean; extensionCount: number; error?: string }>('/tools/reload', {});
      if (result.error) {
        setReloadMessage(`Reload failed: ${result.error}`);
      } else {
        setReloadMessage(`Reloaded ${result.extensionCount} extension(s).`);
        queryClient.invalidateQueries({ queryKey: ['tools'] });
        queryClient.invalidateQueries({ queryKey: ['mcp-tools'] });
      }
    } catch (err) {
      setReloadMessage(`Reload failed: ${(err as Error).message}`);
    } finally {
      setReloading(false);
      setTimeout(() => setReloadMessage(''), 4000);
    }
  }, [queryClient]);

  const { data: toolsData, isLoading } = useQuery({
    queryKey: ['tools'],
    queryFn: async () => {
      try {
        return await api.get<{ tools: ToolModule[] }>('/tools');
      } catch {
        return { tools: [] };
      }
    },
  });

  const { data: permissionsData } = useQuery({
    queryKey: ['tool-permissions'],
    queryFn: async () => {
      try {
        return await api.get<{ permissions: UserPermission[] }>('/tools/permissions');
      } catch {
        return { permissions: [] };
      }
    },
  });

  const { data: mcpData } = useQuery({
    queryKey: ['mcp-tools'],
    queryFn: async () => {
      try {
        return await api.get<{ tools: MCPTool[] }>('/mcp/tools');
      } catch {
        return { tools: [] };
      }
    },
  });

  const { data: roleMapData } = useQuery({
    queryKey: ['tool-role-map'],
    queryFn: async () => {
      try {
        return await api.get<{ byTool: Record<string, string[]> }>('/tools/role-map');
      } catch {
        return { byTool: {} };
      }
    },
  });

  const toolModules = toolsData?.tools || [];
  const userPermissions = permissionsData?.permissions || [];
  const mcpTools = mcpData?.tools || [];
  const roleByTool = roleMapData?.byTool || {};

  const handlePermissionChange = useCallback(
    async (toolId: string, action: string, level: PermissionLevel) => {
      try {
        await api.put('/tools/permissions', { toolId, action, level });
        queryClient.invalidateQueries({ queryKey: ['tool-permissions'] });
      } catch {
        // Ignore
      }
    },
    [queryClient]
  );

  const handlePermissionReset = useCallback(
    async (toolId: string, action: string) => {
      try {
        await api.delete(`/tools/permissions/${toolId}/${action}`);
        queryClient.invalidateQueries({ queryKey: ['tool-permissions'] });
      } catch {
        // Ignore
      }
    },
    [queryClient]
  );

  const filteredModules = searchQuery
    ? toolModules.filter(
        (m) =>
          m.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          m.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
          m.tools.some((t) => t.name.toLowerCase().includes(searchQuery.toLowerCase())) ||
          m.permissions.some((p) => p.action.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : toolModules;

  const filteredMcpTools = searchQuery
    ? mcpTools.filter(
        (t) =>
          t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          t.description.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : mcpTools;

  const totalCapabilities = toolModules.reduce(
    (sum, m) => sum + Math.max(m.tools.length, m.permissions.length),
    0
  ) + mcpTools.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <Wrench className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1">
          <h1 className="text-xl text-on-surface">Tools & Permissions</h1>
          <p className="text-on-surface-variant">
            Executable capabilities available to agents — filesystem, shell, git, browser, email, and more. Each tool has configurable permissions.
          </p>
          <p className="text-sm text-on-surface-variant mt-1">
            {toolModules.length} tool modules, {totalCapabilities} capabilities
            {userPermissions.length > 0 && ` · ${userPermissions.length} custom overrides`}
            {reloadMessage && <span className="ml-2 text-primary">{reloadMessage}</span>}
          </p>
        </div>
        <button
          onClick={handleReload}
          disabled={reloading}
          className="flex items-center gap-2 px-3 py-2 text-sm bg-surface-container border border-outline-variant/10 text-on-surface/80 rounded-lg hover:bg-surface-container-high disabled:opacity-50 cursor-pointer"
          title="Re-discover extensions from ~/.octipus/extensions and .octipus/extensions"
        >
          {reloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
          Reload extensions
        </button>
      </div>

      {/* Permission legend */}
      <div className="flex gap-4 text-xs text-on-surface-variant">
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-green-600 text-on-surface"><Check className="w-3 h-3" /></span>
          <span>Allow — executes without confirmation</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-warning text-on-surface"><HelpCircle className="w-3 h-3" /></span>
          <span>Ask — requires your confirmation</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-red-600 text-on-surface"><X className="w-3 h-3" /></span>
          <span>Deny — blocked</span>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search tools, capabilities, permissions..."
          className="w-full pl-10 pr-4 py-2 bg-surface-container border border-outline-variant/10 rounded-lg text-sm focus:ring-2 focus:ring-primary text-on-surface"
        />
      </div>

      {/* Tool Modules */}
      {isLoading ? (
        <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-8 text-center text-on-surface-variant">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
          Loading...
        </div>
      ) : filteredModules.length === 0 && filteredMcpTools.length === 0 ? (
        <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-8 text-center">
          <Wrench className="w-8 h-8 text-on-surface-variant mx-auto mb-2" />
          <p className="text-on-surface-variant">No tools found</p>
          <p className="text-sm text-on-surface-variant mt-1">Tools are loaded from the backend at startup. Check that the server is running.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredModules.map((module) => (
            <ToolModuleCard
              key={module.id}
              module={module}
              userPermissions={userPermissions}
              roleAccess={roleByTool[module.id] || []}
              onPermissionChange={handlePermissionChange}
              onPermissionReset={handlePermissionReset}
            />
          ))}
        </div>
      )}

      {/* MCP Tools */}
      {filteredMcpTools.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-on-surface-variant uppercase tracking-wider mb-3 flex items-center gap-2">
            <Cable className="w-4 h-4" />
            MCP Tools
          </h2>
          <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-4 space-y-2">
            {filteredMcpTools.map((tool) => (
              <div
                key={`${tool.serverId}-${tool.name}`}
                className="flex items-start gap-3 py-2 border-b last:border-0 border-outline-variant/10"
              >
                <Cable className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono text-on-surface/90">{tool.name}</span>
                    <span className="text-xs text-primary">{tool.serverId}</span>
                  </div>
                  <p className="text-xs text-on-surface-variant">{tool.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
