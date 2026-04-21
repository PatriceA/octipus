'use client';

import {
  Activity,
  Bot,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Clock,
  Coins,
  Layers,
  Loader2,
  Settings2,
  Wrench,
  XCircle,
} from 'lucide-react';
import { useEffect, useState, } from 'react';
import SwarmTree, { type SwarmTreeEvent } from '@/components/swarm-tree';
import { cn } from '@/lib/utils';

// --- Types ---

interface TrackedAgent {
  id: string;
  role: string;
  model: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  toolCalls: Array<{ id: string; name: string; argsSummary?: string }>;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  totalTokens?: number;
  iterations?: number;
  error?: string;
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
  maxTokenBudget: number;
  trackedAgents: Map<string, TrackedAgent>;
  teams: Map<string, TeamState>;
  connectionStatus: 'connected' | 'disconnected' | 'connecting';
  selectedModel: string;
  models: Array<{ name: string; isDefault: boolean }>;
  onModelChange: (model: string) => void;
  selectedPresetId: string | null;
  presets: Array<{ id: string; name: string; description?: string; role: string }>;
  onPresetChange: (presetId: string | null) => void;
  /** Swarm tree lives under Session Stats as the third section. */
  swarmSessionId: string | null;
  latestSwarmEvent?: SwarmTreeEvent | null;
  /** Cumulative wall-clock across all completed swarm nodes (ms). */
  swarmDurationMs?: number;
  /** Called after SwarmTree hydrates from REST with aggregate totals. */
  onSwarmHydratedTotals?: (totals: { tokens: number; durationMs: number }) => void;
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

// TOKEN_BUDGET now comes from props (maxTokenBudget from backend config)

// --- Helpers ---

function getRoleBadgeClasses(role: string): string {
  const color = ROLE_COLORS[role] ?? 'gray';
  const map: Record<string, string> = {
    purple: 'bg-purple-900/40 text-purple-300',
    blue: 'bg-blue-900/40 text-blue-300',
    green: 'bg-green-900/40 text-green-300',
    yellow: 'bg-yellow-900/40 text-yellow-300',
    orange: 'bg-orange-900/40 text-orange-300',
    pink: 'bg-pink-900/40 text-pink-300',
    gray: 'bg-surface-container-highest text-on-surface-variant',
    indigo: 'bg-indigo-900/40 text-indigo-300',
    cyan: 'bg-cyan-900/40 text-cyan-300',
    red: 'bg-red-900/40 text-red-300',
    emerald: 'bg-emerald-900/40 text-emerald-300',
    violet: 'bg-violet-900/40 text-violet-300',
    amber: 'bg-amber-900/40 text-amber-300',
    teal: 'bg-teal-900/40 text-teal-300',
    rose: 'bg-rose-900/40 text-rose-300',
    slate: 'bg-slate-700/40 text-slate-300',
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
  return <span className="tabular-nums text-xs text-on-surface-variant">{formatDuration(elapsed)}</span>;
}

function StatusIcon({ status }: { status: TrackedAgent['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />;
    case 'completed':
      return <CheckCircle className="h-3.5 w-3.5 text-green-500" />;
    case 'failed':
      return <XCircle className="h-3.5 w-3.5 text-red-500" />;
    case 'stopped':
      return <XCircle className="h-3.5 w-3.5 text-yellow-500" />;
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
    <div className="border-b border-outline-variant/10 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 hover:bg-surface-container-high/40"
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
          <Icon className="h-3.5 w-3.5" />
          {title}
        </span>
        {open ? (
          <ChevronUp className="h-3.5 w-3.5 text-on-surface-variant" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-on-surface-variant" />
        )}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

function _AgentCard({ agent }: { agent: TrackedAgent }) {
  const [toolsOpen, setToolsOpen] = useState(false);

  return (
    <div className="rounded-md bg-surface-container-highest p-2 shadow-sm">
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
        <span className="ml-auto text-[10px] text-on-surface-variant">{agent.model}</span>
      </div>

      <div className="mt-1 flex items-center gap-2 text-xs text-on-surface-variant">
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

      {agent.error && (
        <p className="mt-1 text-[10px] text-red-500 truncate" title={agent.error}>
          {agent.error}
        </p>
      )}

      {agent.toolCalls.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setToolsOpen((v) => !v)}
            className="flex items-center gap-1 text-[10px] text-on-surface-variant hover:text-white"
          >
            <Wrench className="h-3 w-3" />
            {agent.toolCalls.length} tool call{agent.toolCalls.length !== 1 ? 's' : ''}
            {toolsOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {toolsOpen && (
            <ul className="mt-1 space-y-0.5 pl-3">
              {agent.toolCalls.map((tc) => (
                <li key={tc.id} className="text-[10px] text-on-surface-variant">
                  <span className="font-mono">{tc.name}</span>
                  {tc.argsSummary && (
                    <span className="ml-1 text-on-surface-variant/60">({tc.argsSummary})</span>
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
  maxTokenBudget,
  trackedAgents,
  teams,
  connectionStatus,
  selectedModel,
  models,
  onModelChange,
  selectedPresetId,
  presets,
  onPresetChange,
  swarmSessionId,
  latestSwarmEvent,
  swarmDurationMs = 0,
  onSwarmHydratedTotals,
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
  const _standaloneAgents = sortedAgents.filter((a) => !teamMemberIds.has(a.id));

  const isUnlimited = maxTokenBudget === 0;
  const tokenPercent = isUnlimited ? 0 : Math.min((totalTokens / maxTokenBudget) * 100, 100);

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
    <div className="flex h-full flex-col overflow-y-auto bg-surface-container">
      {/* Section 1: Connection & Model */}
      <CollapsibleSection title="Connection & Model" icon={Settings2}>
        <div className="space-y-3">
          {/* Connection status */}
          <div className="flex items-center gap-2">
            <span className={cn('h-2 w-2 rounded-full', connectionDot[connectionStatus])} />
            <span className="text-xs text-on-surface-variant">
              {connectionLabel[connectionStatus]}
            </span>
          </div>

          {/* Model (read-only — routing is handled by the orchestrator) */}
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-on-surface-variant">
              Default Model
            </label>
            <div className="w-full rounded-md border border-outline-variant/10 bg-surface-container-highest px-2 py-1 text-xs text-white">
              {selectedModel || 'No model configured'}
            </div>
          </div>

          {/* Expert / Preset pills */}
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-on-surface-variant">
              Expert
            </label>
            <p className="text-[10px] text-on-surface-variant mb-1.5">Chat directly with an expert.</p>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => onPresetChange(null)}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors',
                  selectedPresetId === null
                    ? 'bg-primary text-[#002a6d]'
                    : 'bg-surface-container-highest text-on-surface-variant hover:bg-surface-container-high',
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
                      ? 'bg-primary text-[#002a6d]'
                      : 'bg-surface-container-highest text-on-surface-variant hover:bg-surface-container-high',
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
              <span className="flex items-center gap-1 text-xs text-on-surface-variant">
                <Coins className="h-3 w-3" />
                Tokens
              </span>
              <span className="text-xs tabular-nums text-on-surface-variant">
                {formatTokens(totalTokens)}{isUnlimited ? '' : ` / ${formatTokens(maxTokenBudget)}`}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-highest">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  tokenPercent > 90
                    ? 'bg-error'
                    : tokenPercent > 70
                      ? 'bg-yellow-500'
                      : 'bg-primary',
                )}
                style={{ width: `${tokenPercent}%` }}
              />
            </div>
          </div>

          {/* Active agents */}
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1 text-xs text-on-surface-variant">
              <Bot className="h-3 w-3" />
              Active Agents
            </span>
            <span className="text-xs font-medium tabular-nums text-white">
              {runningAgents.length}
            </span>
          </div>

          {/* Swarm duration — sum of every completed swarm node's wall-clock */}
          {swarmDurationMs > 0 && (
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 text-xs text-on-surface-variant">
                <Clock className="h-3 w-3" />
                Swarm Duration
              </span>
              <span className="tabular-nums text-xs text-on-surface-variant">
                {formatDuration(swarmDurationMs)}
              </span>
            </div>
          )}
        </div>
      </CollapsibleSection>

      {/* Section 3: Swarm Tree (replaces the old Agent Activity section) */}
      <CollapsibleSection title="Swarm" icon={Layers} defaultOpen={true}>
        <SwarmTree
          sessionId={swarmSessionId}
          latestEvent={latestSwarmEvent}
          onHydratedTotals={onSwarmHydratedTotals}
        />
      </CollapsibleSection>
    </div>
  );
}
