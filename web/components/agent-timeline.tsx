'use client';

import {AlertCircle, 
  Brain, CheckCircle, ChevronDown, ChevronRight,Eye, Loader2,
  Shield, Wrench, 
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AgentTimelineEvent } from '@/hooks/useAgentEvents';
import { cn } from '@/lib/utils';

// Preview hints — mirror `src/core/tool-preview.ts` static registry so the UI
// stays informative without a round-trip to the backend.
const TOOL_PREVIEW_PARAMS: Record<string, string> = {
  bash: 'command', shell: 'command', run_command: 'command',
  shell__run_command: 'command', shell__run_background: 'command',
  read: 'path', read_file: 'path', write: 'path', write_file: 'path', edit: 'path',
  filesystem__read: 'path', filesystem__write: 'path', filesystem__edit: 'path',
  grep: 'pattern', glob: 'pattern', search: 'query',
  web_search: 'query', web_fetch: 'url', websearch__search: 'query',
  spawn_child: 'subtopic', escalate_to_different_expert: 'subtopic',
  create_pipeline: 'name',
  knowledge__search: 'query', knowledge__index: 'path',
};

function extractToolPreview(toolName: string, params: Record<string, unknown> | undefined): string {
  if (!params) return '';
  const key = TOOL_PREVIEW_PARAMS[toolName]
    ?? (toolName.includes('__') ? TOOL_PREVIEW_PARAMS[toolName.split('__').pop()!] : undefined);
  const val = key ? params[key] : undefined;
  let out = '';
  if (val !== undefined && val !== null && val !== '') {
    out = typeof val === 'string' ? val : JSON.stringify(val);
  } else {
    const count = Object.keys(params).length;
    return count === 0 ? '' : `${count} param${count === 1 ? '' : 's'}`;
  }
  return out.length > 80 ? out.slice(0, 79) + '…' : out;
}

const EVENT_CONFIG: Record<string, {
  icon: typeof Brain;
  color: string;
  bgColor: string;
  label: string;
}> = {
  thought: { icon: Brain, color: 'text-on-surface-variant', bgColor: 'bg-[#262626]', label: 'Thought' },
  action: { icon: Wrench, color: 'text-blue-400', bgColor: 'bg-blue-900/20', label: 'Action' },
  observation: { icon: Eye, color: 'text-green-400', bgColor: 'bg-green-900/20', label: 'Result' },
  error: { icon: AlertCircle, color: 'text-error', bgColor: 'bg-red-900/20', label: 'Error' },
  complete: { icon: CheckCircle, color: 'text-green-400', bgColor: 'bg-green-900/20', label: 'Complete' },
  status_change: { icon: Loader2, color: 'text-yellow-400', bgColor: 'bg-yellow-900/20', label: 'Status' },
  permission_request: { icon: Shield, color: 'text-orange-400', bgColor: 'bg-orange-900/20', label: 'Permission' },
};

interface TimelineCardProps {
  event: AgentTimelineEvent;
}

function TimelineCard({ event }: TimelineCardProps) {
  const [expanded, setExpanded] = useState(false);
  const config = EVENT_CONFIG[event.type] || EVENT_CONFIG.thought;
  const Icon = config.icon;

  const dataStr = typeof event.data === 'object' && event.data
    ? JSON.stringify(event.data, null, 2)
    : String(event.data || '');

  // Action events render a compact `toolName(preview)` headline before the raw JSON.
  let actionHeadline: string | null = null;
  if (event.type === 'action' && typeof event.data === 'object' && event.data) {
    const d = event.data as { tool?: string; args?: Record<string, unknown>; params?: Record<string, unknown> };
    if (d.tool) {
      const preview = extractToolPreview(d.tool, d.args ?? d.params);
      actionHeadline = preview ? `${d.tool}(${preview})` : `${d.tool}()`;
    }
  }

  const preview = dataStr.length > 120 ? dataStr.slice(0, 120) + '...' : dataStr;
  const hasMore = dataStr.length > 120;

  return (
    <div className={cn('flex gap-3 p-3 rounded-lg', config.bgColor)}>
      <div className={cn('mt-0.5 shrink-0', config.color)}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className={cn('text-xs font-semibold uppercase', config.color)}>
            {config.label}
          </span>
          <span className="text-xs text-on-surface-variant" suppressHydrationWarning>
            {event.timestamp.toLocaleTimeString()}
          </span>
        </div>
        {actionHeadline && !expanded && (
          <div className="text-xs text-blue-200 font-mono mb-1 break-all">{actionHeadline}</div>
        )}
        <pre className="text-xs text-white/80 whitespace-pre-wrap font-mono break-all">
          {expanded ? dataStr : (actionHeadline ? '' : preview)}
        </pre>
        {hasMore && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 mt-1 text-xs text-blue-500 hover:text-blue-600"
          >
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {expanded ? 'Collapse' : 'Show more'}
          </button>
        )}
      </div>
    </div>
  );
}

interface AgentTimelineProps {
  events: AgentTimelineEvent[];
  className?: string;
}

export function AgentTimeline({ events, className }: AgentTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new events
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events.length]);

  if (events.length === 0) {
    return (
      <div className={cn('flex items-center justify-center p-8 text-on-surface-variant text-sm', className)}>
        No events yet. Waiting for agent activity...
      </div>
    );
  }

  return (
    <div ref={scrollRef} className={cn('space-y-2 overflow-y-auto', className)}>
      {events.map((event) => (
        <TimelineCard key={event.id} event={event} />
      ))}
    </div>
  );
}
