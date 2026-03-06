'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  Coins,
  Clock,
  Bot,
  Users,
  ChevronDown,
  ChevronUp,
  Loader2,
  CheckCircle,
  XCircle,
  Wrench,
  Settings2,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// --- Types ---

interface TrackedAgent {
  id: string;
  role: string;
  model: string;
  status: 'running' | 'completed' | 'failed';
  toolCalls: Array<{ id: string; name: string; argsSummary?: string }>;
  startTime: number;
  endTime?: number;
  totalTokens?: number;
  iterations?: number;
  parentAgentId?: string;
  teamId?: string;
}

interface TeamState {
  id: string;
  memberIds: string[];
  status: 'running' | 'completed';
  durationMs?: number;
}

interface SidePanelProps {
  totalTokens: number;
  trackedAgents: Map<string, TrackedAgent>;
  teams: Map<string, TeamState>;
  connectionStatus: 'connected' | 'disconnected' | 'connecting';
  selectedModel: string;
  models: Array<{ name: string; isDefault: boolean }>;
  onModelChange: (model: string) => void;
  selectedPresetId: string | null;
  presets: Array<{ id: string; name: string; description?: string; role: string }>;
  onPresetChange: (presetId: string | null) => void;
}

// --- Constants ---

const ROLE_COLORS: Record<string, string> = {
  orchestrator: 'purple',
  research: 'blue',
  coding: 'green',
  review: 'yellow',
  qa: 'orange',
  communication: 'pink',
  general: 'gray',
  design: 'indigo',
  devops: 'cyan',
  security: 'red',
  data: 'emerald',
  ai: 'violet',
  finance: 'amber',
  automation: 'teal',
  pm: 'rose',
  writing: 'slate',
};

const TOKEN_BUDGET = 100_000;

// --- Helpers ---

function getRoleBadgeClasses(role: string): string {
  const color = ROLE_COLORS[role] ?? 'gray';
  const map: Record<string, string> = {
    purple: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
    blue: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    green: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
    yellow: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300',
    orange: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
    pink: 'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300',
    gray: 'bg-gray-100 text-gray-700 dark:bg-gray-700/40 dark:text-gray-300',
    indigo: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
    cyan: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
    red: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
    emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    violet: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    teal: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
    rose: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
    slate: 'bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-300',
  };
  return map[color] ?? map.gray;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}m ${remaining}s`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

// --- Sub-components ---

function ElapsedTimer({ startTime, endTime }: { startTime: number; endTime?: number }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (endTime) return;
    const interval = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(interval);
  }, [endTime]);

  const elapsed = (endTime ?? now) - startTime;
  return <span className="tabular-nums text-xs text-gray-500 dark:text-gray-400">{formatDuration(elapsed)}</span>;
}

function StatusIcon({ status }: { status: TrackedAgent['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />;
    case 'completed':
      return <CheckCircle className="h-3.5 w-3.5 text-green-500" />;
    case 'failed':
      return <XCircle className="h-3.5 w-3.5 text-red-500" />;
  }
}

function CollapsibleSection({
  title,
  icon: Icon,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-gray-200 dark:border-gray-700 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/40"
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          <Icon className="h-3.5 w-3.5" />
          {title}
        </span>
        {open ? (
          <ChevronUp className="h-3.5 w-3.5 text-gray-400" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
        )}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

function AgentCard({ agent }: { agent: TrackedAgent }) {
  const [toolsOpen, setToolsOpen] = useState(false);

  return (
    <div className="rounded-md bg-white p-2 shadow-sm dark:bg-gray-800/90">
      <div className="flex items-center gap-1.5">
        <StatusIcon status={agent.status} />
        <span
          className={cn(
            'inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none',
            getRoleBadgeClasses(agent.role),
          )}
        >
          {agent.role}
        </span>
        <span className="ml-auto text-[10px] text-gray-400 dark:text-gray-500">{agent.model}</span>
      </div>

      <div className="mt-1 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <ElapsedTimer startTime={agent.startTime} endTime={agent.endTime} />
        {agent.totalTokens != null && (
          <span className="flex items-center gap-0.5">
            <Coins className="h-3 w-3" />
            {formatTokens(agent.totalTokens)}
          </span>
        )}
        {agent.iterations != null && (
          <span className="text-[10px]">{agent.iterations} iter</span>
        )}
      </div>

      {agent.toolCalls.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setToolsOpen((v) => !v)}
            className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <Wrench className="h-3 w-3" />
            {agent.toolCalls.length} tool call{agent.toolCalls.length !== 1 ? 's' : ''}
            {toolsOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {toolsOpen && (
            <ul className="mt-1 space-y-0.5 pl-3">
              {agent.toolCalls.map((tc) => (
                <li key={tc.id} className="text-[10px] text-gray-500 dark:text-gray-400">
                  <span className="font-mono">{tc.name}</span>
                  {tc.argsSummary && (
                    <span className="ml-1 text-gray-400 dark:text-gray-500">({tc.argsSummary})</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// --- Main Component ---

export default function SidePanel({
  totalTokens,
  trackedAgents,
  teams,
  connectionStatus,
  selectedModel,
  models,
  onModelChange,
  selectedPresetId,
  presets,
  onPresetChange,
}: SidePanelProps) {
  const agentArray = Array.from(trackedAgents.values()).filter((a) => a.role !== 'orchestrator');

  const runningAgents = agentArray.filter((a) => a.status === 'running');
  const completedAgents = agentArray
    .filter((a) => a.status !== 'running')
    .sort((a, b) => (b.endTime ?? b.startTime) - (a.endTime ?? a.startTime));

  const sortedAgents = [...runningAgents, ...completedAgents];

  // Agents that belong to a team
  const teamMemberIds = new Set<string>();
  teams.forEach((team) => team.memberIds.forEach((id) => teamMemberIds.add(id)));

  // Standalone agents (not in any team)
  const standaloneAgents = sortedAgents.filter((a) => !teamMemberIds.has(a.id));

  const tokenPercent = Math.min((totalTokens / TOKEN_BUDGET) * 100, 100);

  const connectionDot: Record<string, string> = {
    connected: 'bg-green-500',
    connecting: 'bg-yellow-500 animate-pulse',
    disconnected: 'bg-red-500',
  };

  const connectionLabel: Record<string, string> = {
    connected: 'Connected',
    connecting: 'Connecting...',
    disconnected: 'Disconnected',
  };

  // Session duration from first tracked agent
  const firstStartTime = agentArray.length
    ? Math.min(...agentArray.map((a) => a.startTime))
    : undefined;

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-gray-50 dark:bg-gray-900">
      {/* Section 1: Connection & Model */}
      <CollapsibleSection title="Connection & Model" icon={Settings2}>
        <div className="space-y-3">
          {/* Connection status */}
          <div className="flex items-center gap-2">
            <span className={cn('h-2 w-2 rounded-full', connectionDot[connectionStatus])} />
            <span className="text-xs text-gray-600 dark:text-gray-300">
              {connectionLabel[connectionStatus]}
            </span>
          </div>

          {/* Model selector */}
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Model
            </label>
            <select
              value={selectedModel}
              onChange={(e) => onModelChange(e.target.value)}
              className="w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 shadow-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
            >
              {models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                  {m.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Expert / Preset pills */}
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Expert
            </label>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => onPresetChange(null)}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors',
                  selectedPresetId === null
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 text-gray-600 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600',
                )}
              >
                None
              </button>
              {presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onPresetChange(p.id)}
                  title={p.description}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors',
                    selectedPresetId === p.id
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-200 text-gray-600 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600',
                  )}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      </CollapsibleSection>

      {/* Section 2: Session Stats */}
      <CollapsibleSection title="Session Stats" icon={Activity}>
        <div className="space-y-3">
          {/* Token usage */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
                <Coins className="h-3 w-3" />
                Tokens
              </span>
              <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
                {formatTokens(totalTokens)} / {formatTokens(TOKEN_BUDGET)}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  tokenPercent > 90
                    ? 'bg-red-500'
                    : tokenPercent > 70
                      ? 'bg-yellow-500'
                      : 'bg-blue-500',
                )}
                style={{ width: `${tokenPercent}%` }}
              />
            </div>
          </div>

          {/* Active agents */}
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
              <Bot className="h-3 w-3" />
              Active Agents
            </span>
            <span className="text-xs font-medium tabular-nums text-gray-700 dark:text-gray-200">
              {runningAgents.length}
            </span>
          </div>

          {/* Session duration */}
          {firstStartTime && (
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
                <Clock className="h-3 w-3" />
                Session Duration
              </span>
              <ElapsedTimer
                startTime={firstStartTime}
                endTime={runningAgents.length === 0 ? Date.now() : undefined}
              />
            </div>
          )}
        </div>
      </CollapsibleSection>

      {/* Section 3: Agent Activity */}
      <CollapsibleSection title="Agent Activity" icon={Bot} defaultOpen={true}>
        <div className="max-h-[60vh] space-y-2 overflow-y-auto">
          {sortedAgents.length === 0 && (
            <p className="py-4 text-center text-xs text-gray-400 dark:text-gray-500">
              No agent activity yet
            </p>
          )}

          {/* Team groups */}
          {Array.from(teams.values()).map((team) => {
            const members = team.memberIds
              .map((id) => trackedAgents.get(id))
              .filter((a): a is TrackedAgent => a != null && a.role !== 'orchestrator')
              .sort((a, b) => {
                if (a.status === 'running' && b.status !== 'running') return -1;
                if (a.status !== 'running' && b.status === 'running') return 1;
                return 0;
              });

            if (members.length === 0) return null;

            return (
              <div
                key={team.id}
                className="rounded-lg border border-gray-200 bg-gray-100/50 p-2 dark:border-gray-700 dark:bg-gray-800/50"
              >
                <div className="mb-1.5 flex items-center gap-1.5">
                  <Users className="h-3 w-3 text-gray-500" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Team
                  </span>
                  <span
                    className={cn(
                      'ml-auto inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none',
                      team.status === 'running'
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                        : 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
                    )}
                  >
                    {team.status}
                  </span>
                  {team.durationMs != null && (
                    <span className="text-[10px] tabular-nums text-gray-400">
                      {formatDuration(team.durationMs)}
                    </span>
                  )}
                </div>
                <div className="space-y-1.5">
                  {members.map((agent) => (
                    <AgentCard key={agent.id} agent={agent} />
                  ))}
                </div>
              </div>
            );
          })}

          {/* Standalone agents */}
          {standaloneAgents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      </CollapsibleSection>
    </div>
  );
}
