'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Bot,
  User,
  Zap,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  Volume2,
  Loader2,
  CheckCircle,
  XCircle,
  Wrench,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MessageMetadata {
  model?: string;
  tokens?: number;
  latencyMs?: number;
  cached?: boolean;
}

export interface ChatMessageData {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  agentId?: string;
  classification?: string;
  metadata?: MessageMetadata;
}

export interface TrackedAgent {
  id: string;
  role: string;
  model: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  toolCalls: Array<{ id: string; name: string; argsSummary?: string }>;
  startTime: number;
  endTime?: number;
  totalTokens?: number;
  iterations?: number;
  error?: string;
  parentAgentId?: string;
  teamId?: string;
}

export interface TeamState {
  id: string;
  memberIds: string[];
  status: 'running' | 'completed';
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROLE_COLORS: Record<string, string> = {
  orchestrator: 'border-purple-400 bg-purple-50 dark:bg-purple-900/20',
  research: 'border-blue-400 bg-blue-50 dark:bg-blue-900/20',
  coding: 'border-green-400 bg-green-50 dark:bg-green-900/20',
  review: 'border-yellow-400 bg-yellow-50 dark:bg-yellow-900/20',
  design: 'border-pink-400 bg-pink-50 dark:bg-pink-900/20',
  devops: 'border-orange-400 bg-orange-50 dark:bg-orange-900/20',
  security: 'border-red-400 bg-red-50 dark:bg-red-900/20',
  data: 'border-cyan-400 bg-cyan-50 dark:bg-cyan-900/20',
  ai: 'border-indigo-400 bg-indigo-50 dark:bg-indigo-900/20',
  qa: 'border-teal-400 bg-teal-50 dark:bg-teal-900/20',
  finance: 'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/20',
  automation: 'border-amber-400 bg-amber-50 dark:bg-amber-900/20',
  pm: 'border-violet-400 bg-violet-50 dark:bg-violet-900/20',
  writing: 'border-rose-400 bg-rose-50 dark:bg-rose-900/20',
  communication: 'border-sky-400 bg-sky-50 dark:bg-sky-900/20',
  general: 'border-gray-400 bg-gray-50 dark:bg-gray-800',
};

const ROLE_BADGE_COLORS: Record<string, string> = {
  orchestrator: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  research: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  coding: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  review: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300',
  design: 'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300',
  devops: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  security: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  data: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  ai: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  qa: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  finance: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  automation: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  pm: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  writing: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  communication: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  general: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function getRoleColor(role: string): string {
  return ROLE_COLORS[role] ?? ROLE_COLORS.general;
}

function getRoleBadgeColor(role: string): string {
  return ROLE_BADGE_COLORS[role] ?? ROLE_BADGE_COLORS.general;
}

// ---------------------------------------------------------------------------
// ElapsedTimer
// ---------------------------------------------------------------------------

function ElapsedTimer({ startTime }: { startTime: number }) {
  const [elapsed, setElapsed] = useState(Date.now() - startTime);

  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - startTime), 100);
    return () => clearInterval(id);
  }, [startTime]);

  return <span className="tabular-nums text-xs text-muted-foreground">{formatDuration(elapsed)}</span>;
}

// ---------------------------------------------------------------------------
// CodeBlock
// ---------------------------------------------------------------------------

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  return (
    <div className="relative my-3 rounded-lg bg-gray-900 text-gray-100 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-1.5 bg-gray-800 text-xs text-gray-400">
        <span>{language || 'text'}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 hover:text-gray-200 transition-colors"
          aria-label="Copy code"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto text-sm leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MessageContent
// ---------------------------------------------------------------------------

const CODE_FENCE_RE = /```(\w*)\n([\s\S]*?)```/g;
const INLINE_CODE_RE = /`([^`]+)`/g;

function renderInlineCode(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(INLINE_CODE_RE.source, 'g');

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <code
        key={match.index}
        className="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded font-mono text-sm"
      >
        {match[1]}
      </code>
    );
    lastIndex = re.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

function MessageContent({ content }: { content: string }) {
  const segments: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(CODE_FENCE_RE.source, 'g');

  while ((match = re.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const textPart = content.slice(lastIndex, match.index);
      if (textPart.trim()) {
        segments.push(
          <p key={`t-${lastIndex}`} className="whitespace-pre-wrap">
            {renderInlineCode(textPart)}
          </p>
        );
      }
    }
    segments.push(
      <CodeBlock key={`c-${match.index}`} language={match[1]} code={match[2]} />
    );
    lastIndex = re.lastIndex;
  }

  if (lastIndex < content.length) {
    const remaining = content.slice(lastIndex);
    if (remaining.trim()) {
      segments.push(
        <p key={`t-${lastIndex}`} className="whitespace-pre-wrap">
          {renderInlineCode(remaining)}
        </p>
      );
    }
  }

  return <div className="space-y-2">{segments}</div>;
}

// ---------------------------------------------------------------------------
// MessageBubble
// ---------------------------------------------------------------------------

function MessageBubble({ message }: { message: ChatMessageData }) {
  const { role, content, timestamp, classification, metadata } = message;
  const timeStr = new Date(timestamp).toLocaleTimeString();

  if (role === 'system') {
    return (
      <div className="flex justify-center py-2">
        <div className="text-center text-sm italic text-muted-foreground max-w-lg px-4 py-2 rounded-lg bg-muted/40">
          <MessageContent content={content} />
          <p className="text-[10px] mt-1 text-muted-foreground/60">{timeStr}</p>
        </div>
      </div>
    );
  }

  if (role === 'user') {
    return (
      <div className="flex justify-end py-1.5 group">
        <div className="flex flex-col items-end gap-0.5">
          <div className="bg-primary text-primary-foreground px-4 py-2.5 rounded-2xl rounded-br-md shadow-sm">
            <p className="whitespace-pre-wrap text-sm">{content}</p>
          </div>
          <span className="text-[10px] text-muted-foreground/60 px-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {timeStr}
          </span>
        </div>
      </div>
    );
  }

  // assistant
  return (
    <div className="flex gap-3 py-1.5 group">
      <div className="flex-shrink-0 mt-1">
        <div className="h-7 w-7 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-sm">
          <Bot className="h-4 w-4 text-white" />
        </div>
      </div>
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <div className="bg-white dark:bg-gray-900 border border-border/50 px-4 py-3 rounded-2xl rounded-tl-md shadow-sm">
          <MessageContent content={content} />
        </div>

        {/* Metadata bar */}
        <div className="flex items-center gap-2 px-1 flex-wrap">
          <span className="text-[10px] text-muted-foreground/60 opacity-0 group-hover:opacity-100 transition-opacity">
            {timeStr}
          </span>

          {classification && classification !== 'casual' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
              {classification}
            </span>
          )}

          {metadata?.model && (
            <span className="text-[10px] text-muted-foreground/60">{metadata.model}</span>
          )}

          {metadata?.tokens != null && (
            <span className="text-[10px] text-muted-foreground/60">
              <Zap className="inline h-2.5 w-2.5 mr-0.5" />
              {metadata.tokens} tok
            </span>
          )}

          {metadata?.latencyMs != null && (
            <span className="text-[10px] text-muted-foreground/60">
              {formatDuration(metadata.latencyMs)}
            </span>
          )}

          {metadata?.cached && (
            <span className="text-[10px] text-muted-foreground/60">
              <Volume2 className="inline h-2.5 w-2.5 mr-0.5" />
              cached
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentActivityInline
// ---------------------------------------------------------------------------

function AgentActivityInline({ agent }: { agent: TrackedAgent }) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon =
    agent.status === 'running' ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
    ) : agent.status === 'completed' ? (
      <CheckCircle className="h-3.5 w-3.5 text-green-500" />
    ) : (
      <XCircle className="h-3.5 w-3.5 text-red-500" />
    );

  const durationMs =
    agent.endTime != null ? agent.endTime - agent.startTime : undefined;

  return (
    <div
      className={cn(
        'my-1.5 mx-8 rounded-lg border-l-[3px] px-3 py-2 text-xs transition-colors',
        getRoleColor(agent.role)
      )}
    >
      <div className="flex items-center gap-2 flex-wrap">
        {statusIcon}

        <span className={cn('px-1.5 py-0.5 rounded-md font-medium text-[11px]', getRoleBadgeColor(agent.role))}>
          {agent.role}
        </span>

        <span className="text-muted-foreground">{agent.model}</span>

        {agent.status === 'running' ? (
          <ElapsedTimer startTime={agent.startTime} />
        ) : durationMs != null ? (
          <span className="text-muted-foreground tabular-nums">{formatDuration(durationMs)}</span>
        ) : null}

        {agent.totalTokens != null && (
          <span className="text-muted-foreground">
            <Zap className="inline h-2.5 w-2.5 mr-0.5" />
            {agent.totalTokens} tok
          </span>
        )}

        {agent.iterations != null && (
          <span className="text-muted-foreground">{agent.iterations} iter</span>
        )}

        {agent.error && (
          <span className="text-red-500 truncate max-w-[300px]" title={agent.error}>
            {agent.error}
          </span>
        )}

        {agent.toolCalls.length > 0 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-0.5 text-muted-foreground hover:text-foreground transition-colors ml-auto"
          >
            <Wrench className="h-3 w-3" />
            {agent.toolCalls.length}
            {expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        )}
      </div>

      {expanded && agent.toolCalls.length > 0 && (
        <div className="mt-2 space-y-1 pl-5">
          {agent.toolCalls.map((tc) => (
            <div key={tc.id} className="flex items-center gap-2 text-muted-foreground">
              <Wrench className="h-2.5 w-2.5 flex-shrink-0" />
              <span className="font-mono">{tc.name}</span>
              {tc.argsSummary && (
                <span className="truncate max-w-xs opacity-60">{tc.argsSummary}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TeamActivityInline
// ---------------------------------------------------------------------------

function TeamActivityInline({
  teamId,
  members,
  status,
  durationMs,
}: {
  teamId: string;
  members: TrackedAgent[];
  status: string;
  durationMs?: number;
}) {
  const [expanded, setExpanded] = useState(true);

  const statusIcon =
    status === 'running' ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
    ) : (
      <CheckCircle className="h-3.5 w-3.5 text-green-500" />
    );

  return (
    <div className="my-2 mx-8 rounded-lg border border-border/60 bg-muted/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50 transition-colors"
      >
        {statusIcon}
        <Users className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium">Team</span>
        <span className="text-muted-foreground">{members.length} agents</span>

        {durationMs != null && (
          <span className="text-muted-foreground tabular-nums">{formatDuration(durationMs)}</span>
        )}

        <span className="ml-auto">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </span>
      </button>

      {expanded && (
        <div className="px-1 pb-2 space-y-0.5">
          {members.map((agent) => (
            <AgentActivityInline key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MessageTimeline (main export)
// ---------------------------------------------------------------------------

interface MessageTimelineProps {
  messages: ChatMessageData[];
  trackedAgents: Map<string, TrackedAgent>;
  teams: Map<string, TeamState>;
  isLoading: boolean;
  statusMessage: string | null;
}

type TimelineEntry =
  | { kind: 'message'; data: ChatMessageData; sortKey: number }
  | { kind: 'agent'; data: TrackedAgent; sortKey: number }
  | { kind: 'team'; data: { teamId: string; members: TrackedAgent[]; status: string; durationMs?: number }; sortKey: number };

export default function MessageTimeline({
  messages,
  trackedAgents,
  teams,
  isLoading,
  statusMessage,
}: MessageTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const isNearBottomRef = useRef(true);

  // Build unified timeline
  const timeline: TimelineEntry[] = [];

  // Messages
  for (const msg of messages) {
    timeline.push({
      kind: 'message',
      data: msg,
      sortKey: new Date(msg.timestamp).getTime(),
    });
  }

  // Agents that are not part of a team
  const teamMemberIds = new Set<string>();
  Array.from(teams.values()).forEach((team) => {
    for (const memberId of team.memberIds) {
      teamMemberIds.add(memberId);
    }
  });

  Array.from(trackedAgents.values()).forEach((agent) => {
    if (!agent.teamId && !teamMemberIds.has(agent.id)) {
      timeline.push({
        kind: 'agent',
        data: agent,
        sortKey: agent.startTime,
      });
    }
  });

  // Teams
  Array.from(teams.entries()).forEach(([teamId, team]) => {
    const members = team.memberIds
      .map((id: string) => trackedAgents.get(id))
      .filter((a: TrackedAgent | undefined): a is TrackedAgent => a != null);

    if (members.length > 0) {
      const earliest = Math.min(...members.map((m: TrackedAgent) => m.startTime));
      timeline.push({
        kind: 'team',
        data: {
          teamId,
          members,
          status: team.status,
          durationMs: team.durationMs,
        },
        sortKey: earliest,
      });
    }
  });

  timeline.sort((a, b) => a.sortKey - b.sortKey);

  // Auto-scroll
  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    if (isNearBottomRef.current) {
      scrollToBottom();
    }
  }, [messages.length, trackedAgents.size, isLoading, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < 120;
    isNearBottomRef.current = nearBottom;
    setShowScrollBtn(!nearBottom);
  }, []);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-4 py-4 space-y-1 relative"
    >
      {/* Empty state */}
      {messages.length === 0 && !isLoading && (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
          <Bot className="h-10 w-10 opacity-30" />
          <p className="text-sm">Start a conversation</p>
        </div>
      )}

      {/* Timeline entries */}
      {timeline.map((entry, idx) => {
        switch (entry.kind) {
          case 'message':
            return <MessageBubble key={`msg-${entry.data.id}`} message={entry.data} />;
          case 'agent':
            return <AgentActivityInline key={`agent-${entry.data.id}`} agent={entry.data} />;
          case 'team':
            return (
              <TeamActivityInline
                key={`team-${entry.data.teamId}`}
                teamId={entry.data.teamId}
                members={entry.data.members}
                status={entry.data.status}
                durationMs={entry.data.durationMs}
              />
            );
        }
      })}

      {/* Loading indicator */}
      {isLoading && (
        <div className="flex items-center gap-2 py-3 px-2">
          <div className="h-7 w-7 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-sm">
            <Loader2 className="h-4 w-4 text-white animate-spin" />
          </div>
          <span className="text-sm text-muted-foreground animate-pulse">
            {statusMessage || 'Thinking...'}
          </span>
        </div>
      )}

      {/* Scroll anchor */}
      <div ref={bottomRef} />

      {/* Scroll-to-bottom button */}
      {showScrollBtn && (
        <button
          onClick={scrollToBottom}
          className="sticky bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-background/90 border border-border shadow-lg text-xs text-muted-foreground hover:text-foreground transition-colors backdrop-blur-sm"
        >
          <ChevronDown className="h-3.5 w-3.5" />
          Scroll to bottom
        </button>
      )}
    </div>
  );
}
