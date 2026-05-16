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
  // Roles collapse onto the four palette accents so a long agent
  // tree doesn't degenerate into a rainbow. Mostly dim, with the
  // hot statuses (security / qa / review / error-prone) flagged in
  // warning/error tones for at-a-glance triage.
  const tone = ROLE_COLORS[role] ?? 'gray';
  const map: Record<string, string> = {
    purple:   'bg-primary-container/40 border-primary/60 text-primary',
    blue:     'bg-primary-container/40 border-primary/60 text-primary',
    cyan:     'bg-primary-container/40 border-primary/60 text-primary',
    indigo:   'bg-primary-container/40 border-primary/60 text-primary',
    violet:   'bg-primary-container/40 border-primary/60 text-primary',
    green:    'bg-tertiary-container/40 border-tertiary/60 text-tertiary',
    emerald:  'bg-tertiary-container/40 border-tertiary/60 text-tertiary',
    teal:     'bg-tertiary-container/40 border-tertiary/60 text-tertiary',
    yellow:   'bg-warning-container/40 border-warning/60 text-warning',
    orange:   'bg-warning-container/40 border-warning/60 text-warning',
    amber:    'bg-warning-container/40 border-warning/60 text-warning',
    red:      'bg-error-container/40 border-error/60 text-error',
    rose:     'bg-error-container/40 border-error/60 text-error',
    pink:     'bg-error-container/40 border-error/60 text-error',
    slate:    'bg-surface-container-high border-outline-variant text-on-surface-variant',
    gray:     'bg-surface-container-high border-outline-variant text-on-surface-variant',
  };
  return map[tone] ?? map.gray;
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
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
    case 'completed':
      return <CheckCircle className="h-3.5 w-3.5 text-tertiary" />;
    case 'failed':
      return <XCircle className="h-3.5 w-3.5 text-error" />;
    case 'stopped':
      return <XCircle className="h-3.5 w-3.5 text-warning" />;
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
    <div className="border-b border-outline-variant/60 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-1.5 bg-surface-container-low/60 hover:bg-surface-container transition-colors cursor-pointer"
      >
        <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-on-surface-variant">
          <span aria-hidden className="text-outline-variant">▸</span>
          <Icon className="h-3 w-3" />
          {title}
        </span>
        {open ? (
          <ChevronUp className="h-3 w-3 text-outline-variant" />
        ) : (
          <ChevronDown className="h-3 w-3 text-outline-variant" />
        )}
      </button>
      {open && <div className="px-3 py-2">{children}</div>}
    </div>
  );
}

function _AgentCard({ agent }: { agent: TrackedAgent }) {
  const [toolsOpen, setToolsOpen] = useState(false);

  return (
    <div className="rounded-xs bg-surface-container-high border border-outline-variant/40 p-2 font-mono">
      <div className="flex items-center gap-1.5">
        <StatusIcon status={agent.status} />
        <span
          className={cn(
            'inline-block rounded-xs border px-1.5 py-0.5 text-[10px] uppercase tracking-wider leading-none',
            getRoleBadgeClasses(agent.role),
          )}
        >
          {agent.role}
        </span>
        <span className="ml-auto text-[10px] text-outline-variant truncate">{agent.model}</span>
      </div>

      <div className="mt-1 flex items-center gap-2 text-[11px] text-on-surface-variant tabular-nums">
        <ElapsedTimer startTime={agent.startTime} endTime={agent.endTime} />
        {agent.totalTokens != null && (
          <span className="flex items-center gap-0.5">
            <Coins className="h-3 w-3" />
            {formatTokens(agent.totalTokens)}
          </span>
        )}
        {agent.iterations != null && (
          <span className="text-[10px]">· {agent.iterations} iter</span>
        )}
      </div>

      {agent.error && (
        <p className="mt-1 text-[10px] text-error truncate" title={agent.error}>
          ! {agent.error}
        </p>
      )}

      {agent.toolCalls.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setToolsOpen((v) => !v)}
            className="flex items-center gap-1 text-[10px] text-on-surface-variant hover:text-on-surface cursor-pointer"
          >
            <Wrench className="h-3 w-3" />
            {agent.toolCalls.length} tool call{agent.toolCalls.length !== 1 ? 's' : ''}
            {toolsOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {toolsOpen && (
            <ul className="mt-1 space-y-0.5 pl-3 border-l border-outline-variant/40">
              {agent.toolCalls.map((tc) => (
                <li key={tc.id} className="text-[10px] text-on-surface-variant pl-2">
                  <span className="text-primary">›</span> <span>{tc.name}</span>
                  {tc.argsSummary && (
                    <span className="ml-1 text-outline">({tc.argsSummary})</span>
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
    connected: 'dot dot-ok',
    connecting: 'dot dot-warn animate-pulse',
    disconnected: 'dot dot-err',
  };

  const connectionLabel: Record<string, string> = {
    connected: 'connected',
    connecting: 'connecting…',
    disconnected: 'disconnected',
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-surface-container-low font-mono">
      <CollapsibleSection title="connection & model" icon={Settings2}>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span aria-hidden className={connectionDot[connectionStatus]} />
            <span className="text-[11px] text-on-surface-variant">{connectionLabel[connectionStatus]}</span>
          </div>

          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-outline-variant">
              default model
            </label>
            <div className="w-full rounded-xs border border-outline-variant/60 bg-surface-container px-2 py-1 text-[12px] text-on-surface truncate">
              {selectedModel || 'no model configured'}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-outline-variant">
              expert
            </label>
            <p className="text-[10px] text-outline mb-1.5">chat directly with an expert.</p>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => onPresetChange(null)}
                className={cn(
                  'rounded-xs border px-2 py-0.5 text-[10px] transition-colors cursor-pointer',
                  selectedPresetId === null
                    ? 'bg-primary-container/40 border-primary text-primary'
                    : 'border-outline-variant/60 text-on-surface-variant hover:border-outline hover:text-on-surface',
                )}
              >
                none
              </button>
              {presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onPresetChange(p.id)}
                  title={p.description}
                  className={cn(
                    'rounded-xs border px-2 py-0.5 text-[10px] transition-colors cursor-pointer',
                    selectedPresetId === p.id
                      ? 'bg-primary-container/40 border-primary text-primary'
                      : 'border-outline-variant/60 text-on-surface-variant hover:border-outline hover:text-on-surface',
                  )}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="session stats" icon={Activity}>
        <div className="space-y-3">
          <div>
            <div className="mb-1 flex items-center justify-between text-[11px]">
              <span className="flex items-center gap-1 text-on-surface-variant">
                <Coins className="h-3 w-3" />
                tokens
              </span>
              <span className="text-on-surface-variant tabular-nums">
                {formatTokens(totalTokens)}{isUnlimited ? '' : ` / ${formatTokens(maxTokenBudget)}`}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-xs bg-outline-variant/30">
              <div
                className={cn(
                  'h-full transition-all',
                  tokenPercent > 90 ? 'bg-error' : tokenPercent > 70 ? 'bg-warning' : 'bg-primary',
                )}
                style={{ width: `${tokenPercent}%` }}
              />
            </div>
          </div>

          <div className="flex items-center justify-between text-[11px]">
            <span className="flex items-center gap-1 text-on-surface-variant">
              <Bot className="h-3 w-3" />
              active agents
            </span>
            <span className="tabular-nums text-on-surface">
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
