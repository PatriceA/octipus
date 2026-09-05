'use client';

import {
  Bot,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  FileEdit,
  FilePlus,
  FileText,
  FileX,
  Loader2,
  Users,
  Volume2,
  Wrench,
  XCircle,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { compareTimelineEntries } from '../../../src/shared/timeline-order';
import type { ToolInputPreview, ToolResultPreview } from '../../../src/shared/work-stream';
import DiffView from '@/components/chat/diff-view';
import { Markdown } from '@/components/ui/markdown-renderer';
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
  role: 'user' | 'assistant' | 'system' | 'narration';
  content: string;
  timestamp: Date;
  agentId?: string;
  classification?: string;
  metadata?: MessageMetadata;
}

export interface TrackedAgent {
  id: string;
  role: string;
  /** The turn's root agent — Octipus itself, not a specialist it spawned. */
  root?: boolean;
  model: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  toolCalls: Array<{
    id: string;
    name: string;
    argsSummary?: string;
    /** Filled by the `tool_call_complete` event (Phase 5). */
    status?: string;
    durationMs?: number;
    resultPreview?: string;
    error?: string;
    /** Rich work-stream fields (Thread 1) — human title + structured preview. */
    title?: string;
    input?: ToolInputPreview;
    result?: ToolResultPreview;
  }>;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  totalTokens?: number;
  iterations?: number;
  error?: string;
  parentAgentId?: string;
  teamId?: string;
  stageName?: string;
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
  rootAgent: 'border-purple-400 bg-purple-900/20',
  research: 'border-accent/60 bg-accent-container/60',
  coding: 'border-tertiary/60 bg-tertiary-container/60',
  review: 'border-warning/60 bg-warning-container/60',
  design: 'border-pink-400 bg-pink-900/20',
  devops: 'border-warning/60 bg-warning-container/60',
  security: 'border-error/60 bg-error-container/60',
  data: 'border-cyan-400 bg-cyan-900/20',
  ai: 'border-indigo-400 bg-indigo-900/20',
  qa: 'border-teal-400 bg-teal-900/20',
  finance: 'border-emerald-400 bg-emerald-900/20',
  automation: 'border-amber-400 bg-amber-900/20',
  pm: 'border-violet-400 bg-violet-900/20',
  writing: 'border-rose-400 bg-rose-900/20',
  communication: 'border-sky-400 bg-sky-900/20',
  general: 'border-gray-400 bg-surface-container-highest',
};

const ROLE_BADGE_COLORS: Record<string, string> = {
  rootAgent: 'bg-purple-900/40 text-primary',
  research: 'bg-primary-container/60 text-primary',
  coding: 'bg-tertiary-container/60 text-tertiary',
  review: 'bg-warning-container/60 text-warning',
  design: 'bg-pink-900/40 text-error',
  devops: 'bg-warning-container/60 text-warning',
  security: 'bg-error-container/60 text-error',
  data: 'bg-cyan-900/40 text-primary',
  ai: 'bg-indigo-900/40 text-primary',
  qa: 'bg-teal-900/40 text-tertiary',
  finance: 'bg-emerald-900/40 text-tertiary',
  automation: 'bg-amber-900/40 text-warning',
  pm: 'bg-violet-900/40 text-primary',
  writing: 'bg-rose-900/40 text-error',
  communication: 'bg-sky-900/40 text-sky-300',
  general: 'bg-surface-container-highest text-on-surface-variant',
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

function ElapsedTimer({ startTime, active = true }: { startTime: number; active?: boolean }) {
  // Stopwatch seed — intentionally time-based and re-synced every 100ms by the
  // interval below; an inactive (completed) timer must still show its frozen
  // elapsed, so the initial value has to read the clock.
  // eslint-disable-next-line react-hooks/purity
  const [elapsed, setElapsed] = useState(Date.now() - startTime);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setElapsed(Date.now() - startTime), 100);
    return () => clearInterval(id);
  }, [startTime, active]);

  return <span className="tabular-nums text-xs text-on-surface-variant">{formatDuration(elapsed)}</span>;
}

// ---------------------------------------------------------------------------
// MessageContent — markdown rendered via the shared <Markdown> component
// (web/components/ui/markdown-renderer.tsx), so chat, research, documents and
// notes all render markdown identically.
// ---------------------------------------------------------------------------

function MessageContent({ content }: { content: string }) {
  return <Markdown content={content} />;
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
        <div className="text-center text-sm italic text-on-surface-variant max-w-lg px-4 py-2 rounded-lg bg-surface-container/60">
          <MessageContent content={content} />
          <p className="text-[10px] mt-1 text-on-surface-variant/60">{timeStr}</p>
        </div>
      </div>
    );
  }

  if (role === 'narration') {
    return (
      <div className="flex justify-center py-1 group">
        <div className="inline-flex items-center gap-2 text-xs italic text-on-surface-variant/70 max-w-lg px-3 py-1 rounded-full bg-surface-container/30 border border-outline-variant/10">
          <Volume2 className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
          <span className="whitespace-pre-wrap">{content}</span>
          <span className="text-[10px] text-on-surface-variant/40 opacity-0 group-hover:opacity-100 transition-opacity">{timeStr}</span>
        </div>
      </div>
    );
  }

  if (role === 'user') {
    return (
      <div className="flex justify-end py-1.5 group" data-role="user">
        <div className="flex flex-col items-end gap-0.5">
          <div className="bg-linear-to-r from-primary to-primary-container text-on-primary px-4 py-2.5 rounded-2xl rounded-br-md shadow-xs">
            <p className="whitespace-pre-wrap text-sm">{content}</p>
          </div>
          <span className="text-[10px] text-on-surface-variant/60 px-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {timeStr}
          </span>
        </div>
      </div>
    );
  }

  // assistant
  return (
    // `data-role` is the only thing here a test can key on: the role is
    // otherwise expressed as layout and colour. Without it, checking that an
    // answer arrived means matching page text — which matches the question the
    // moment it is echoed into the transcript.
    <div className="flex gap-3 py-1.5 group" data-role="assistant">
      <div className="shrink-0 mt-1">
        <div className="h-7 w-7 rounded-full bg-linear-to-br from-primary to-primary-container flex items-center justify-center shadow-xs">
          <Bot className="h-4 w-4 text-on-primary" />
        </div>
      </div>
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <div className="bg-surface-container border border-outline-variant/10 px-4 py-3 rounded-2xl rounded-tl-md shadow-xs text-on-surface">
          <MessageContent content={content} />
        </div>

        {/* Metadata bar */}
        <div className="flex items-center gap-2 px-1 flex-wrap">
          <span className="text-[10px] text-on-surface-variant/60 opacity-0 group-hover:opacity-100 transition-opacity">
            {timeStr}
          </span>

          {classification && classification !== 'casual' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant font-medium">
              {classification}
            </span>
          )}

          {metadata?.model && (
            <span className="text-[10px] text-on-surface-variant/60">{metadata.model}</span>
          )}

          {metadata?.tokens != null && (
            <span className="text-[10px] text-on-surface-variant/60">
              <Zap className="inline h-2.5 w-2.5 mr-0.5" />
              {metadata.tokens} tok
            </span>
          )}

          {metadata?.latencyMs != null && (
            <span className="text-[10px] text-on-surface-variant/60">
              {formatDuration(metadata.latencyMs)}
            </span>
          )}

          {metadata?.cached && (
            <span className="text-[10px] text-on-surface-variant/60">
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

type ToolCall = TrackedAgent['toolCalls'][number];

// Structured result preview (Thread 1) — picks a renderer per result `kind` so
// the user sees a diff / exit code / file list / image / text excerpt instead
// of a truncated one-line JSON blob. A `file` result is click-to-open in the
// in-chat file view (Thread 2) when `onOpenFile` is wired.
function ToolResultPreviewView({ result, onOpenFile }: { result: ToolResultPreview; onOpenFile?: (path: string) => void }) {
  switch (result.kind) {
    case 'empty':
      return null;
    case 'text':
      return (
        <pre className="mt-1 max-h-40 overflow-auto rounded bg-[#0d1117] border border-white/10 px-2 py-1 text-[11px] font-mono text-on-surface/80 whitespace-pre-wrap">
          {result.text}{result.truncated ? '\n…' : ''}
        </pre>
      );
    case 'exit':
      return (
        <div className="mt-1 max-h-40 overflow-auto rounded bg-[#0d1117] border border-white/10 text-[11px] font-mono">
          <div className={cn('px-2 py-0.5', result.ok ? 'text-tertiary' : 'text-error')}>
            exit {result.code}
          </div>
          {result.tail && (
            <pre className="px-2 py-1 text-on-surface/70 whitespace-pre-wrap border-t border-white/5">{result.tail}</pre>
          )}
        </div>
      );
    case 'list':
      return (
        <ul className="mt-1 max-h-40 overflow-auto rounded bg-[#0d1117] border border-white/10 px-2 py-1 text-[11px] font-mono text-on-surface/80 space-y-px">
          {result.items.map((item, i) => (
            <li key={i} className="truncate" title={item}>{item}</li>
          ))}
          {result.total != null && result.total > result.items.length && (
            <li className="text-on-surface-variant/60 italic">…{result.total - result.items.length} more</li>
          )}
        </ul>
      );
    case 'diff':
      return (
        <div className="mt-1">
          {(result.added > 0 || result.removed > 0) && (
            <div className="mb-0.5 flex gap-2 px-1 font-mono text-[10px]">
              <span className="text-tertiary">+{result.added}</span>
              <span className="text-error">−{result.removed}</span>
            </div>
          )}
          <DiffView patch={result.patch} className="max-h-40 py-1" />
        </div>
      );
    case 'file': {
      const label = (
        <>
          <FileText className="h-3 w-3 shrink-0" />
          <span className="truncate" title={result.path}>{result.path.replace(/\\/g, '/').split('/').slice(-2).join('/')}</span>
          {result.bytes != null && <span className="text-on-surface-variant/60">({result.bytes}B)</span>}
        </>
      );
      return onOpenFile ? (
        <button
          type="button"
          onClick={() => onOpenFile(result.path)}
          title={`Open ${result.path}`}
          className="mt-1 flex w-full items-center gap-1.5 rounded-xs px-1 py-0.5 text-left text-[11px] font-mono text-primary hover:bg-surface-container hover:underline"
        >
          {label}
        </button>
      ) : (
        <div className="mt-1 flex items-center gap-1.5 px-1 text-[11px] text-on-surface-variant font-mono">
          {label}
        </div>
      );
    }
    case 'image':
      return (
        // Dynamic tool-result image (data: URL or artifact ref) — next/image
        // would force `unoptimized`/domain config here for no benefit.
        <img
          src={result.ref}
          alt="tool result"
          className="mt-1 max-h-40 rounded border border-white/10 object-contain"
        />
      );
  }
}

// `terminal` = the owning agent has finished. A finished agent will never
// send another result, so a status-less row must NOT keep spinning (P1.5) —
// show a neutral completed dot instead.
function statusDot(status?: string, terminal?: boolean) {
  if (status === 'error') return <XCircle className="h-3 w-3 shrink-0 text-error" />;
  if (status === 'cancelled') return <XCircle className="h-3 w-3 shrink-0 text-warning" />;
  if (status === 'ok' || status === 'completed') return <CheckCircle className="h-3 w-3 shrink-0 text-tertiary" />;
  if (terminal) return <CheckCircle className="h-3 w-3 shrink-0 text-on-surface-variant/50" />;
  return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />;
}

// One tool call in the expanded list: a human title (falls back to the raw
// name), an inline input subject / args summary as a secondary line, a
// duration, and a collapsible result preview.
function ToolCallRow({ tc, onOpenFile, terminal }: { tc: ToolCall; onOpenFile?: (path: string) => void; terminal?: boolean }) {
  const [open, setOpen] = useState(false);
  const label = tc.title || tc.name;
  // Secondary line: the input subject (Thread 1) or the CLI args summary
  // (e.g. codex "git status -sb") — the raw command was previously never shown.
  const secondary = tc.input?.value ?? tc.argsSummary;
  const showSecondary = secondary && secondary !== label;
  const hasPreview = (tc.result && tc.result.kind !== 'empty') || !!tc.error;
  return (
    <div className="text-[11px]">
      <div
        className={cn('flex items-center gap-1.5 py-0.5', hasPreview && 'cursor-pointer hover:text-on-surface')}
        onClick={hasPreview ? () => setOpen((v) => !v) : undefined}
      >
        {statusDot(tc.status, terminal)}
        <span className="text-on-surface/80 truncate" title={secondary}>{label}</span>
        {tc.durationMs != null && (
          <span className="text-on-surface-variant/60 tabular-nums shrink-0">{formatDuration(tc.durationMs)}</span>
        )}
        {hasPreview && (
          open
            ? <ChevronDown className="h-3 w-3 text-on-surface-variant ml-auto shrink-0" />
            : <ChevronRight className="h-3 w-3 text-on-surface-variant ml-auto shrink-0" />
        )}
      </div>
      {showSecondary && (
        <div className="ml-[18px] truncate font-mono text-[10px] text-on-surface-variant/70" title={secondary}>
          {secondary}
        </div>
      )}
      {open && (
        <div className="ml-4">
          {tc.error
            ? <pre className="mt-1 rounded bg-error-container/20 border border-error/20 px-2 py-1 text-[11px] text-error whitespace-pre-wrap">{tc.error}</pre>
            : tc.result && <ToolResultPreviewView result={tc.result} onOpenFile={onOpenFile} />}
        </div>
      )}
    </div>
  );
}

function AgentActivityInline({ agent, onOpenFile }: { agent: TrackedAgent; onOpenFile?: (path: string) => void }) {
  const [toolsOpen, setToolsOpen] = useState(false);

  const statusIcon =
    agent.status === 'running' ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
    ) : agent.status === 'completed' ? (
      <CheckCircle className="h-3.5 w-3.5 text-tertiary" />
    ) : (
      <XCircle className="h-3.5 w-3.5 text-error" />
    );

  const durationMs =
    agent.durationMs ?? (agent.endTime != null ? agent.endTime - agent.startTime : undefined);

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

        <span className="text-on-surface-variant">{agent.model}</span>

        {agent.status === 'running' ? (
          <ElapsedTimer startTime={agent.startTime} active={agent.status === 'running'} />
        ) : durationMs != null ? (
          <span className="text-on-surface-variant tabular-nums">{formatDuration(durationMs)}</span>
        ) : null}

        {agent.totalTokens != null && (
          <span className="text-on-surface-variant">
            <Zap className="inline h-2.5 w-2.5 mr-0.5" />
            {agent.totalTokens} tok
          </span>
        )}

        {agent.iterations != null && (
          <span className="text-on-surface-variant">{agent.iterations} iter</span>
        )}

        {agent.error && (
          <span className="text-error truncate max-w-[300px]" title={agent.error}>
            {agent.error}
          </span>
        )}

        {agent.toolCalls.length > 0 && (
          <button
            type="button"
            onClick={() => setToolsOpen((v) => !v)}
            className="flex items-center gap-0.5 text-on-surface-variant hover:text-on-surface ml-auto cursor-pointer"
            title={`${agent.toolCalls.length} tool call${agent.toolCalls.length === 1 ? '' : 's'}`}
          >
            <Wrench className="h-3 w-3" />
            {agent.toolCalls.length}
            {toolsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        )}
      </div>

      {toolsOpen && agent.toolCalls.length > 0 && (
        <div className="mt-1.5 space-y-0.5 border-t border-outline-variant/20 pt-1.5">
          {agent.toolCalls.map((tc) => (
            <ToolCallRow key={tc.id} tc={tc} onOpenFile={onOpenFile} terminal={agent.status !== 'running'} />
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
  onOpenFile,
}: {
  teamId: string;
  members: TrackedAgent[];
  status: string;
  durationMs?: number;
  onOpenFile?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  const statusIcon =
    status === 'running' ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
    ) : (
      <CheckCircle className="h-3.5 w-3.5 text-tertiary" />
    );

  return (
    <div className="my-2 mx-8 rounded-lg border border-outline-variant/10 bg-surface-container/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-surface-container-high/50 transition-colors"
      >
        {statusIcon}
        <Users className="h-3.5 w-3.5 text-on-surface-variant" />
        <span className="font-medium">Team</span>
        <span className="text-on-surface-variant">{members.length} agents</span>

        {durationMs != null && (
          <span className="text-on-surface-variant tabular-nums">{formatDuration(durationMs)}</span>
        )}

        <span className="ml-auto">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-on-surface-variant" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-on-surface-variant" />
          )}
        </span>
      </button>

      {expanded && (
        <div className="px-1 pb-2 space-y-0.5">
          {members.map((agent) => (
            <AgentActivityInline key={agent.id} agent={agent} onOpenFile={onOpenFile} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// FileChangesInline — shows file changes grouped by agent
// ---------------------------------------------------------------------------

const FILE_ACTION_ICONS: Record<string, { icon: typeof FileText; color: string; label: string }> = {
  write: { icon: FilePlus, color: 'text-tertiary', label: 'created' },
  create: { icon: FilePlus, color: 'text-tertiary', label: 'created' },
  edit: { icon: FileEdit, color: 'text-warning', label: 'modified' },
  append: { icon: FileEdit, color: 'text-warning', label: 'modified' },
  delete: { icon: FileX, color: 'text-error', label: 'deleted' },
  move: { icon: FileEdit, color: 'text-primary', label: 'moved' },
  copy: { icon: FilePlus, color: 'text-primary', label: 'copied' },
  create_dir: { icon: FilePlus, color: 'text-tertiary', label: 'created dir' },
};

function FileDiffView({ change }: { change: FileChange }) {
  const hasContent = change.content !== undefined || change.oldContent !== undefined;
  if (!hasContent) return null;

  const isEdit = change.action === 'edit' && change.oldContent !== undefined && change.content !== undefined;

  if (isEdit) {
    // Show inline diff: old lines in red, new lines in green
    const oldLines = change.oldContent!.split('\n');
    const newLines = change.content!.split('\n');
    return (
      <div className="mt-1 rounded bg-[#0d1117] border border-white/10 overflow-auto max-h-48 text-xs font-mono">
        {oldLines.map((line, i) => (
          <div key={`old-${i}`} className="px-2 py-px bg-error-container/60 text-error whitespace-pre">
            <span className="select-none text-error/60 mr-2">-</span>{line}
          </div>
        ))}
        {newLines.map((line, i) => (
          <div key={`new-${i}`} className="px-2 py-px bg-tertiary-container/60 text-tertiary whitespace-pre">
            <span className="select-none text-tertiary/60 mr-2">+</span>{line}
          </div>
        ))}
      </div>
    );
  }

  // Write/create: show new content in green
  if (change.content !== undefined) {
    const lines = change.content.split('\n');
    return (
      <div className="mt-1 rounded bg-[#0d1117] border border-white/10 overflow-auto max-h-48 text-xs font-mono">
        {lines.map((line, i) => (
          <div key={i} className="px-2 py-px bg-tertiary-container/60 text-tertiary whitespace-pre">
            <span className="select-none text-tertiary/60 mr-2">+</span>{line}
          </div>
        ))}
      </div>
    );
  }

  return null;
}

function FileChangesInline({ group }: { group: FileChangeGroup }) {
  const [expanded, setExpanded] = useState(false);
  const [expandedDiffs, setExpandedDiffs] = useState<Set<string>>(new Set());

  // Deduplicate by path (keep latest action)
  const uniqueChanges = new Map<string, FileChange>();
  for (const change of group.changes) {
    uniqueChanges.set(change.path, change);
  }
  const changes = Array.from(uniqueChanges.values());

  const toggleDiff = (path: string) => {
    setExpandedDiffs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="ml-9 my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs text-on-surface-variant hover:text-on-surface cursor-pointer py-1"
      >
        <FileText className="w-3.5 h-3.5" />
        <span className="font-medium text-on-surface/70">
          {group.agentRole}
        </span>
        <span>{changes.length} file{changes.length !== 1 ? 's' : ''} changed</span>
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>

      {expanded && (
        <div className="ml-5 mt-1 space-y-1">
          {changes.map((change, i) => {
            const info = FILE_ACTION_ICONS[change.action] || FILE_ACTION_ICONS.write;
            const Icon = info.icon;
            const shortPath = change.path.replace(/\\/g, '/').split('/').slice(-3).join('/');
            const hasDiff = change.content !== undefined || change.oldContent !== undefined;
            const diffOpen = expandedDiffs.has(change.path);
            return (
              <div key={`${change.path}-${i}`}>
                <div
                  className={cn(
                    'flex items-center gap-2 text-xs py-0.5',
                    hasDiff && 'cursor-pointer hover:text-on-surface',
                  )}
                  onClick={hasDiff ? () => toggleDiff(change.path) : undefined}
                >
                  <Icon className={cn('w-3 h-3 shrink-0', info.color)} />
                  <span className="font-mono text-on-surface/80 truncate" title={change.path}>{shortPath}</span>
                  <span className="text-on-surface-variant">({info.label})</span>
                  {hasDiff && (
                    diffOpen
                      ? <ChevronDown className="w-3 h-3 text-on-surface-variant ml-auto" />
                      : <ChevronRight className="w-3 h-3 text-on-surface-variant ml-auto" />
                  )}
                </div>
                {hasDiff && diffOpen && <FileDiffView change={change} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MessageTimeline (main export)
// ---------------------------------------------------------------------------

export interface FileChange {
  path: string;
  action: string;
  agentId: string;
  agentRole: string;
  timestamp: string;
  content?: string;     // new content (for writes)
  oldContent?: string;  // old content (for edits - old_string)
}

interface FileChangeGroup {
  agentId: string;
  agentRole: string;
  changes: FileChange[];
  timestamp: number;
}

interface MessageTimelineProps {
  messages: ChatMessageData[];
  trackedAgents: Map<string, TrackedAgent>;
  teams: Map<string, TeamState>;
  fileChanges?: FileChange[];
  isLoading: boolean;
  statusMessage: string | null;
  /** Open a file (by resolved path) in the in-chat file view (Thread 2). */
  onOpenFile?: (path: string) => void;
}

type TimelineEntry =
  | { kind: 'message'; data: ChatMessageData; sortKey: number }
  | { kind: 'agent'; data: TrackedAgent; sortKey: number }
  | { kind: 'team'; data: { teamId: string; members: TrackedAgent[]; status: string; durationMs?: number }; sortKey: number }
  | { kind: 'file_changes'; data: FileChangeGroup; sortKey: number };

export default function MessageTimeline({
  messages,
  trackedAgents,
  teams,
  fileChanges,
  isLoading,
  statusMessage,
  onOpenFile,
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

  // Agents that are not part of a team — positioned at their actual start time.
  // The secondary sort (kindOrder: message=0, agent=1) ensures agents appear
  // after any message with the same timestamp.
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

  // File changes grouped by agent
  if (fileChanges && fileChanges.length > 0) {
    const groups = new Map<string, FileChangeGroup>();
    for (const fc of fileChanges) {
      const key = fc.agentId;
      if (!groups.has(key)) {
        groups.set(key, {
          agentId: fc.agentId,
          agentRole: fc.agentRole,
          changes: [],
          timestamp: new Date(fc.timestamp).getTime(),
        });
      }
      const group = groups.get(key)!;
      group.changes.push(fc);
      group.timestamp = Math.max(group.timestamp, new Date(fc.timestamp).getTime());
    }
    for (const group of Array.from(groups.values())) {
      timeline.push({
        kind: 'file_changes',
        data: group,
        sortKey: group.timestamp,
      });
    }
  }

  timeline.sort(compareTimelineEntries);

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
        <div className="flex flex-col items-center justify-center h-full text-on-surface-variant gap-3">
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
            return <AgentActivityInline key={`agent-${entry.data.id}`} agent={entry.data} onOpenFile={onOpenFile} />;
          case 'team':
            return (
              <TeamActivityInline
                key={`team-${entry.data.teamId}`}
                teamId={entry.data.teamId}
                members={entry.data.members}
                status={entry.data.status}
                durationMs={entry.data.durationMs}
                onOpenFile={onOpenFile}
              />
            );
          case 'file_changes':
            return <FileChangesInline key={`files-${entry.data.agentId}`} group={entry.data} />;
        }
      })}

      {/* Loading indicator */}
      {isLoading && (
        <div className="flex items-center gap-2 py-3 px-2">
          <div className="h-7 w-7 rounded-full bg-linear-to-br from-primary to-primary-container flex items-center justify-center shadow-xs">
            <Loader2 className="h-4 w-4 text-on-primary animate-spin" />
          </div>
          <span className="text-sm text-accent animate-pulse">
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
          className="sticky bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-container/90 border border-outline-variant/10 shadow-lg text-xs text-on-surface-variant hover:text-on-surface transition-colors backdrop-blur-xs"
        >
          <ChevronDown className="h-3.5 w-3.5" />
          Scroll to bottom
        </button>
      )}
    </div>
  );
}
