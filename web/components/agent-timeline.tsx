'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Brain, Wrench, Eye, AlertCircle, CheckCircle, Loader2,
  Shield, ChevronDown, ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgentTimelineEvent } from '@/hooks/useAgentEvents';

const EVENT_CONFIG: Record<string, {
  icon: typeof Brain;
  color: string;
  bgColor: string;
  label: string;
}> = {
  thought: { icon: Brain, color: 'text-gray-500', bgColor: 'bg-gray-100 dark:bg-gray-700', label: 'Thought' },
  action: { icon: Wrench, color: 'text-blue-500', bgColor: 'bg-blue-50 dark:bg-blue-900/20', label: 'Action' },
  observation: { icon: Eye, color: 'text-green-500', bgColor: 'bg-green-50 dark:bg-green-900/20', label: 'Result' },
  error: { icon: AlertCircle, color: 'text-red-500', bgColor: 'bg-red-50 dark:bg-red-900/20', label: 'Error' },
  complete: { icon: CheckCircle, color: 'text-green-600', bgColor: 'bg-green-50 dark:bg-green-900/20', label: 'Complete' },
  status_change: { icon: Loader2, color: 'text-yellow-500', bgColor: 'bg-yellow-50 dark:bg-yellow-900/20', label: 'Status' },
  permission_request: { icon: Shield, color: 'text-orange-500', bgColor: 'bg-orange-50 dark:bg-orange-900/20', label: 'Permission' },
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

  const preview = dataStr.length > 120 ? dataStr.slice(0, 120) + '...' : dataStr;
  const hasMore = dataStr.length > 120;

  return (
    <div className={cn('flex gap-3 p-3 rounded-lg', config.bgColor)}>
      <div className={cn('mt-0.5 flex-shrink-0', config.color)}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className={cn('text-xs font-semibold uppercase', config.color)}>
            {config.label}
          </span>
          <span className="text-xs text-gray-400" suppressHydrationWarning>
            {event.timestamp.toLocaleTimeString()}
          </span>
        </div>
        <pre className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap font-mono break-all">
          {expanded ? dataStr : preview}
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
      <div className={cn('flex items-center justify-center p-8 text-gray-400 text-sm', className)}>
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
