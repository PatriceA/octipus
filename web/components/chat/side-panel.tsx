'use client';

import {
  Activity,
  Bot,
  ChevronDown,
  ChevronUp,
  Clock,
  Coins,
  FileText,
  GitCompare,
  Layers,
  Settings2,
} from 'lucide-react';
import { useState } from 'react';
import SwarmTree, { type SwarmTreeEvent } from '@/components/swarm-tree';
import { cn } from '@/lib/utils';
import ChangesTab from './changes-tab';

// --- Types ---

interface TrackedAgent {
  id: string;
  role: string;
  /** The turn's root agent — Octipus itself, not a specialist it spawned. */
  root?: boolean;
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

/** A file the agents touched this session — the Files tab list (Thread 2). */
interface SessionFile {
  path: string;
  action: string;
  agentRole: string;
}

interface SidePanelProps {
  totalTokens: number;
  maxTokenBudget: number;
  trackedAgents: Map<string, TrackedAgent>;
  teams: Map<string, TeamState>;
  /** Files written/edited this session — opened in the in-chat file view. */
  sessionFiles?: SessionFile[];
  /** Open a file in the in-chat file view (Thread 2). */
  onOpenFile?: (path: string) => void;
  connectionStatus: 'connected' | 'disconnected' | 'connecting';
  selectedModel: string;
  models: Array<{ name: string; isDefault: boolean }>;
  onModelChange: (model: string) => void;
  selectedPresetId: string | null;
  presets: Array<{ id: string; name: string; description?: string; role: string }>;
  onPresetChange: (presetId: string | null) => void;
  /** Swarm tree lives under Session Stats as the third section. */
  swarmSessionId: string | null;
  /** Append-only queue of swarm events. SwarmTree tracks its own consumed
   *  index; we use a queue instead of a single "latest" event because React
   *  18 batches rapid setState calls and would otherwise drop intermediate
   *  spawns when several arrive in the same render. */
  swarmEvents?: SwarmTreeEvent[];
  /** Cumulative wall-clock across all completed swarm nodes (ms). */
  swarmDurationMs?: number;
  /** Called after SwarmTree hydrates from REST with aggregate totals. */
  onSwarmHydratedTotals?: (totals: { tokens: number; durationMs: number }) => void;
}

// TOKEN_BUDGET now comes from props (maxTokenBudget from backend config)

// --- Helpers ---

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
          <span aria-hidden className="text-primary font-bold">&gt;</span>
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

// --- Main Component ---

export default function SidePanel({
  totalTokens,
  maxTokenBudget,
  trackedAgents,
  teams,
  sessionFiles,
  onOpenFile,
  connectionStatus,
  selectedModel,
  models,
  onModelChange,
  selectedPresetId,
  presets,
  onPresetChange,
  swarmSessionId,
  swarmEvents,
  swarmDurationMs = 0,
  onSwarmHydratedTotals,
}: SidePanelProps) {
  // Dedupe touched files by path (keep the most recent action) for the Files
  // tab. `delete` actions drop out — there's nothing to open.
  const dedupedFiles = (() => {
    const byPath = new Map<string, SessionFile>();
    for (const f of sessionFiles ?? []) byPath.set(f.path, f);
    return Array.from(byPath.values()).filter((f) => !/delete/i.test(f.action));
  })();

  // The root agent is Octipus answering, not one of the agents it dispatched —
  // the panel lists the latter. Older sessions carry the retired role name
  // instead of the flag, so both are filtered.
  const agentArray = Array.from(trackedAgents.values()).filter((a) => !a.root && a.role !== 'orchestrator');

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
    connecting: 'dot dot-warn dot-live text-warning',
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

      {/* Files touched this session — click to open the in-chat file view. */}
      <CollapsibleSection title="files" icon={FileText} defaultOpen={dedupedFiles.length > 0}>
        {dedupedFiles.length === 0 ? (
          <p className="text-[10px] italic text-outline">no files yet — ask the agent to write one.</p>
        ) : (
          <ul className="space-y-0.5">
            {dedupedFiles.map((f) => {
              const name = f.path.replace(/\\/g, '/').split('/').pop() || f.path;
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    onClick={() => onOpenFile?.(f.path)}
                    disabled={!onOpenFile}
                    title={f.path}
                    className="flex w-full items-center gap-1.5 rounded-xs px-1 py-0.5 text-left text-[11px] text-on-surface-variant hover:bg-surface-container hover:text-on-surface disabled:cursor-default"
                  >
                    <FileText className="h-3 w-3 shrink-0 text-primary" />
                    <span className="truncate font-mono">{name}</span>
                    <span className="ml-auto shrink-0 text-[9px] uppercase text-outline">{f.action}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CollapsibleSection>

      {/* Git-backed review of what the agent changed in the workspace. Lazy —
          the section only fetches when expanded (ChangesTab mounts on open). */}
      <CollapsibleSection title="changes" icon={GitCompare} defaultOpen={false}>
        <ChangesTab sessionId={swarmSessionId} />
      </CollapsibleSection>

      {/* Section 3: Swarm Tree (replaces the old Agent Activity section) */}
      <CollapsibleSection title="Swarm" icon={Layers} defaultOpen={true}>
        <SwarmTree
          sessionId={swarmSessionId}
          events={swarmEvents}
          onHydratedTotals={onSwarmHydratedTotals}
        />
      </CollapsibleSection>
    </div>
  );
}
