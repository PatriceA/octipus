'use client';

import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Puzzle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Wrench,
  Shield,
  Cable,
  Search,
  Check,
  HelpCircle,
  X,
  RotateCcw,
} from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface SkillPermission {
  action: string;
  description: string;
  defaultLevel: 'ALLOW' | 'ASK' | 'DENY';
  dangerous?: boolean;
}

interface SkillTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  returns: string;
}

interface Skill {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  isInitialized: boolean;
  permissions: SkillPermission[];
  tools: SkillTool[];
}

interface UserPermission {
  skillId: string;
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

const LEVEL_CONFIG: Record<PermissionLevel, { color: string; icon: typeof Check; label: string }> = {
  ALLOW: {
    color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    icon: Check,
    label: 'Allow',
  },
  ASK: {
    color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
    icon: HelpCircle,
    label: 'Ask',
  },
  DENY: {
    color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
    icon: X,
    label: 'Deny',
  },
};

function LevelBadge({ level }: { level: PermissionLevel }) {
  const { color, icon: Icon } = LEVEL_CONFIG[level];
  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium', color)}>
      <Icon className="w-3 h-3" />
      {level}
    </span>
  );
}

function LevelSelector({
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
    <div className="flex items-center gap-1.5">
      {(['ALLOW', 'ASK', 'DENY'] as PermissionLevel[]).map((level) => {
        const active = currentLevel === level;
        const { icon: Icon } = LEVEL_CONFIG[level];
        return (
          <button
            key={level}
            onClick={() => onChange(level)}
            className={cn(
              'px-2 py-1 rounded text-xs font-medium cursor-pointer flex items-center gap-1 transition-colors',
              active
                ? level === 'ALLOW'
                  ? 'bg-green-600 text-white'
                  : level === 'ASK'
                  ? 'bg-yellow-500 text-white'
                  : 'bg-red-600 text-white'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
            )}
          >
            <Icon className="w-3 h-3" />
            {level}
          </button>
        );
      })}
      {isOverride && (
        <button
          onClick={onReset}
          className="p-1 text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
          title={`Reset to default (${defaultLevel})`}
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

function SkillCard({
  skill,
  userPermissions,
  onPermissionChange,
  onPermissionReset,
}: {
  skill: Skill;
  userPermissions: UserPermission[];
  onPermissionChange: (skillId: string, action: string, level: PermissionLevel) => void;
  onPermissionReset: (skillId: string, action: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const getEffectiveLevel = (perm: SkillPermission): PermissionLevel => {
    const override = userPermissions.find((p) => p.skillId === skill.id && p.action === perm.action);
    return override?.level || perm.defaultLevel;
  };

  const hasOverride = (perm: SkillPermission): boolean => {
    return userPermissions.some((p) => p.skillId === skill.id && p.action === perm.action);
  };

  const overrideCount = skill.permissions.filter((p) => hasOverride(p)).length;

  return (
    <div className="bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 flex items-center justify-between text-left cursor-pointer"
      >
        <div className="flex items-center gap-3">
          <div className="text-gray-500">
            {expanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
          </div>
          <Puzzle className="w-5 h-5 text-blue-500" />
          <div>
            <h3 className="font-medium text-gray-900 dark:text-gray-100">{skill.name}</h3>
            <p className="text-xs text-gray-500">{skill.description}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">{skill.tools.length} tools</span>
          {skill.permissions.length > 0 && (
            <span className="text-sm text-gray-500">{skill.permissions.length} permissions</span>
          )}
          {overrideCount > 0 && (
            <span className="px-2 py-0.5 text-xs rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
              {overrideCount} custom
            </span>
          )}
          <span className="text-xs text-gray-500">v{skill.version}</span>
          <span
            className={cn(
              'px-2 py-0.5 text-xs rounded-full',
              skill.isInitialized
                ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
            )}
          >
            {skill.isInitialized ? 'Active' : 'Inactive'}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-200 dark:border-gray-700">
          {/* Permissions */}
          {skill.permissions.length > 0 && (
            <div className="p-4 border-b border-gray-200 dark:border-gray-700">
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-1.5">
                <Shield className="w-4 h-4" />
                Permissions
              </h4>
              <div className="space-y-2">
                {skill.permissions.map((perm) => {
                  const effectiveLevel = getEffectiveLevel(perm);
                  const isOverride = hasOverride(perm);

                  return (
                    <div
                      key={perm.action}
                      className={cn(
                        'flex items-center justify-between py-2 px-3 rounded-lg',
                        isOverride
                          ? 'bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800'
                          : 'bg-gray-50 dark:bg-gray-700/30'
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            {perm.action}
                          </span>
                          {perm.dangerous && (
                            <span className="px-1.5 py-0.5 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-xs rounded">
                              dangerous
                            </span>
                          )}
                          {isOverride && (
                            <span className="text-xs text-blue-500">
                              (default: {perm.defaultLevel})
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">{perm.description}</p>
                      </div>
                      <LevelSelector
                        currentLevel={effectiveLevel}
                        defaultLevel={perm.defaultLevel}
                        onChange={(level) => onPermissionChange(skill.id, perm.action, level)}
                        onReset={() => onPermissionReset(skill.id, perm.action)}
                        isOverride={isOverride}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tools */}
          <div className="p-4">
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-1.5">
              <Wrench className="w-4 h-4" />
              Tools
            </h4>
            <div className="space-y-2">
              {skill.tools.map((tool) => (
                <ToolCard key={tool.name} tool={tool} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolCard({ tool }: { tool: SkillTool }) {
  const [showParams, setShowParams] = useState(false);
  const params = tool.parameters || {};
  const properties = (params as Record<string, unknown>).properties as
    | Record<string, { type?: string; description?: string }>
    | undefined;

  return (
    <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm font-mono text-gray-800 dark:text-gray-200">{tool.name}</span>
          <p className="text-xs text-gray-500 mt-0.5">{tool.description}</p>
        </div>
        {properties && Object.keys(properties).length > 0 && (
          <button
            onClick={() => setShowParams(!showParams)}
            className="text-xs text-blue-500 hover:text-blue-700 cursor-pointer"
          >
            {showParams ? 'hide params' : `${Object.keys(properties).length} params`}
          </button>
        )}
      </div>

      {showParams && properties && (
        <div className="mt-2 space-y-1">
          {Object.entries(properties).map(([name, schema]) => (
            <div key={name} className="flex items-baseline gap-2 text-xs">
              <span className="font-mono text-gray-700 dark:text-gray-300">{name}</span>
              <span className="text-gray-500">{schema.type || 'any'}</span>
              {schema.description && <span className="text-gray-500">— {schema.description}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SkillsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const queryClient = useQueryClient();

  const { data: skillsData, isLoading: skillsLoading } = useQuery({
    queryKey: ['tools'],
    queryFn: async () => {
      try {
        return await api.get<{ tools: Skill[] }>('/tools');
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

  const skills = skillsData?.tools || [];
  const userPermissions = permissionsData?.permissions || [];
  const mcpTools = mcpData?.tools || [];

  const handlePermissionChange = useCallback(
    async (skillId: string, action: string, level: PermissionLevel) => {
      try {
        await api.put('/tools/permissions', { skillId, action, level });
        queryClient.invalidateQueries({ queryKey: ['tool-permissions'] });
      } catch {
        // Ignore
      }
    },
    [queryClient]
  );

  const handlePermissionReset = useCallback(
    async (skillId: string, action: string) => {
      try {
        await api.delete(`/tools/permissions/${skillId}/${action}`);
        queryClient.invalidateQueries({ queryKey: ['tool-permissions'] });
      } catch {
        // Ignore
      }
    },
    [queryClient]
  );

  const filteredSkills = searchQuery
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.tools.some((t) => t.name.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : skills;

  const filteredMcpTools = searchQuery
    ? mcpTools.filter(
        (t) =>
          t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          t.description.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : mcpTools;

  const totalTools = skills.reduce((sum, s) => sum + s.tools.length, 0) + mcpTools.length;
  const totalOverrides = userPermissions.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary-100 dark:bg-primary-950/40 flex items-center justify-center">
          <Puzzle className="w-5 h-5 text-primary-600 dark:text-primary-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Skills & Tools</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {skills.length} skills, {totalTools} tools available
            {totalOverrides > 0 && ` \u00b7 ${totalOverrides} custom permissions`}
          </p>
        </div>
      </div>

      {/* Permission level legend */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 border border-green-200 dark:border-green-800">
          <div className="flex items-center gap-1.5 mb-1">
            <Check className="w-4 h-4 text-green-600" />
            <h3 className="font-semibold text-green-900 dark:text-green-100 text-sm">ALLOW</h3>
          </div>
          <p className="text-xs text-green-700 dark:text-green-300">Executes without confirmation</p>
        </div>
        <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-3 border border-yellow-200 dark:border-yellow-800">
          <div className="flex items-center gap-1.5 mb-1">
            <HelpCircle className="w-4 h-4 text-yellow-600" />
            <h3 className="font-semibold text-yellow-900 dark:text-yellow-100 text-sm">ASK</h3>
          </div>
          <p className="text-xs text-yellow-700 dark:text-yellow-300">Requires your confirmation first</p>
        </div>
        <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-3 border border-red-200 dark:border-red-800">
          <div className="flex items-center gap-1.5 mb-1">
            <X className="w-4 h-4 text-red-600" />
            <h3 className="font-semibold text-red-900 dark:text-red-100 text-sm">DENY</h3>
          </div>
          <p className="text-xs text-red-700 dark:text-red-300">Blocked, cannot execute</p>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search skills, tools, or permissions..."
          className="w-full pl-10 pr-4 py-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 dark:text-gray-100"
        />
      </div>

      {/* Native Skills */}
      {skillsLoading ? (
        <div className="bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60 p-8 text-center text-gray-500">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
          Loading...
        </div>
      ) : filteredSkills.length === 0 ? (
        <div className="bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60 p-8 text-center">
          <Puzzle className="w-8 h-8 text-gray-500 mx-auto mb-2" />
          <p className="text-gray-500">No skills found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredSkills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              userPermissions={userPermissions}
              onPermissionChange={handlePermissionChange}
              onPermissionReset={handlePermissionReset}
            />
          ))}
        </div>
      )}

      {/* MCP Tools */}
      {filteredMcpTools.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Cable className="w-4 h-4" />
            MCP Tools
          </h2>
          <div className="bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60 p-4 space-y-2">
            {filteredMcpTools.map((tool) => (
              <div
                key={`${tool.serverId}-${tool.name}`}
                className="flex items-start gap-3 py-2 border-b last:border-0 border-gray-100 dark:border-gray-700"
              >
                <Cable className="w-4 h-4 text-purple-400 mt-0.5 shrink-0" />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono text-gray-800 dark:text-gray-200">{tool.name}</span>
                    <span className="text-xs text-purple-400">{tool.serverId}</span>
                  </div>
                  <p className="text-xs text-gray-500">{tool.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
