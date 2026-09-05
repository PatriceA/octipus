'use client';

import { CheckCircle, ChevronDown, ChevronUp, Loader2, Users, Wrench, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

export interface ToolCallInfo {
  id: string;
  name: string;
  argsSummary?: string;
}

export interface TrackedAgent {
  id: string;
  role: string;
  /** The turn's root agent — Octipus itself, not a specialist it spawned. */
  root?: boolean;
  model: string;
  status: 'running' | 'completed' | 'failed';
  toolCalls: ToolCallInfo[];
  startTime: number;
  endTime?: number;
  durationMs?: number;
  totalTokens?: number;
  iterations?: number;
  parentAgentId?: string;
  teamId?: string;
  stageName?: string;
}

interface AgentActivityCardProps {
  agent: TrackedAgent;
}

function ElapsedTimer({ startTime, endTime }: { startTime: number; endTime?: number }) {
  const [elapsed, setElapsed] = useState(() => (endTime ? endTime - startTime : Date.now() - startTime));

  useEffect(() => {
    if (endTime) {
      return;
    }
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTime);
    }, 100);
    return () => clearInterval(interval);
  }, [startTime, endTime]);

  const finalElapsed = endTime ? endTime - startTime : elapsed;
  const seconds = (finalElapsed / 1000).toFixed(1);
  return <span className="font-mono">{seconds}s</span>;
}

const ROLE_COLORS: Record<string, string> = {
  rootAgent: 'bg-purple-900/30 text-primary',
  research: 'bg-primary-container/60 text-primary',
  coding: 'bg-tertiary-container/60 text-tertiary',
  review: 'bg-warning-container/60 text-warning',
  qa: 'bg-warning-container/60 text-warning',
  communication: 'bg-pink-900/30 text-error',
  general: 'bg-surface-container-highest text-on-surface-variant',
};

export function AgentActivityCard({ agent }: AgentActivityCardProps) {
  const [expanded, setExpanded] = useState(false);
  const colorClass = ROLE_COLORS[agent.role] || ROLE_COLORS.general;

  return (
    <div className="flex gap-3 justify-start">
      <div className="w-8 h-8 rounded-full bg-indigo-900 flex items-center justify-center shrink-0">
        <Wrench className="w-4 h-4 text-primary" />
      </div>
      <div className="max-w-[80%] bg-indigo-900/10 border border-outline-variant/10 px-3 py-2 rounded-lg text-sm">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn('px-1.5 py-0.5 rounded text-xs font-medium', colorClass)}>
            {agent.stageName ? `${agent.stageName}` : agent.role}
          </span>
          <span className="text-xs text-on-surface-variant font-mono">{agent.model}</span>
          {agent.status === 'running' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
          ) : agent.status === 'completed' ? (
            <CheckCircle className="w-3.5 h-3.5 text-tertiary" />
          ) : (
            <XCircle className="w-3.5 h-3.5 text-error" />
          )}
          <span className="text-xs text-on-surface-variant">
            <ElapsedTimer startTime={agent.startTime} endTime={agent.endTime} />
          </span>
          {agent.totalTokens != null && agent.totalTokens > 0 && (
            <span className="text-xs text-on-surface-variant font-mono">{agent.totalTokens}t</span>
          )}
          {agent.toolCalls.length > 0 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-0.5 text-xs text-on-surface-variant hover:text-on-surface"
            >
              <span>{agent.toolCalls.length} tools</span>
              {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          )}
        </div>
        {expanded && agent.toolCalls.length > 0 && (
          <div className="mt-2 space-y-1 border-t border-outline-variant/10 pt-2">
            {agent.toolCalls.map((tc) => (
              <div key={tc.id} className="text-xs text-on-surface-variant font-mono truncate">
                <span className="text-primary">{tc.name}</span>
                {tc.argsSummary && <span className="text-on-surface-variant/60"> {tc.argsSummary}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Team card wrapping multiple agents
interface TeamCardProps {
  teamId: string;
  members: TrackedAgent[];
  status: 'running' | 'completed';
  durationMs?: number;
}

export function TeamCard({ teamId, members, status, durationMs }: TeamCardProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="flex gap-3 justify-start">
      <div className="w-8 h-8 rounded-full bg-violet-900 flex items-center justify-center shrink-0">
        <Users className="w-4 h-4 text-primary" />
      </div>
      <div className="max-w-[85%] bg-violet-900/10 border border-outline-variant/10 px-3 py-2 rounded-lg text-sm">
        <div className="flex items-center gap-2">
          <span className="font-medium text-primary">Team</span>
          <span className="text-xs text-on-surface-variant">{members.length} agents</span>
          {status === 'running' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
          ) : (
            <CheckCircle className="w-3.5 h-3.5 text-tertiary" />
          )}
          {durationMs != null && (
            <span className="text-xs text-on-surface-variant font-mono">{(durationMs / 1000).toFixed(1)}s</span>
          )}
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-on-surface-variant hover:text-on-surface"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>
        {expanded && (
          <div className="mt-2 space-y-2 border-t border-outline-variant/10 pt-2">
            {members.map((agent) => (
              <div key={agent.id} className="flex items-center gap-2 text-xs">
                <span className={cn('px-1.5 py-0.5 rounded font-medium', ROLE_COLORS[agent.role] || ROLE_COLORS.general)}>
                  {agent.role}
                </span>
                {agent.status === 'running' ? (
                  <Loader2 className="w-3 h-3 animate-spin text-on-surface-variant" />
                ) : agent.status === 'completed' ? (
                  <CheckCircle className="w-3 h-3 text-tertiary" />
                ) : (
                  <XCircle className="w-3 h-3 text-error" />
                )}
                {agent.totalTokens != null && agent.totalTokens > 0 && (
                  <span className="text-on-surface-variant font-mono">{agent.totalTokens}t</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
