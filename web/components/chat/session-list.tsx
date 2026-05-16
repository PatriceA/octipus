'use client';

import { Code2, Globe, Hash, MessageSquare, MoreHorizontal, Pencil, Plus, Search, Smartphone, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, } from 'react';
import { cn } from '@/lib/utils';

export interface SessionInfo {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  tokenCount: number;
  status: string;
  devMode?: boolean;
  projectName?: string;
  channelType?: string;
}

interface SessionListProps {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

function getTimeGroup(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

  if (date >= startOfToday) return 'Today';
  if (date >= startOfYesterday) return 'Yesterday';
  if (date >= startOfWeek) return 'This Week';
  return 'Older';
}

function timeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffWeek = Math.floor(diffDay / 7);

  if (diffSec < 60) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHour < 24) return `${diffHour}h`;
  if (diffDay < 7) return `${diffDay}d`;
  if (diffWeek < 52) return `${diffWeek}w`;
  return `${Math.floor(diffDay / 365)}y`;
}

const GROUP_ORDER = ['Today', 'Yesterday', 'This Week', 'Older'];

export function SessionList({
  sessions,
  activeSessionId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
}: SessionListProps) {
  const [search, setSearch] = useState('');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenId(null);
        setConfirmDeleteId(null);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus rename input when entering rename mode
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const filtered = sessions.filter((s) =>
    s.title.toLowerCase().includes(search.toLowerCase())
  );

  const grouped = GROUP_ORDER.reduce<Record<string, SessionInfo[]>>((acc, group) => {
    const items = filtered.filter((s) => getTimeGroup(s.updatedAt) === group);
    if (items.length > 0) acc[group] = items;
    return acc;
  }, {});

  const handleStartRename = (session: SessionInfo) => {
    setRenamingId(session.id);
    setRenameValue(session.title);
    setMenuOpenId(null);
  };

  const handleFinishRename = () => {
    if (renamingId && renameValue.trim()) {
      onRename(renamingId, renameValue.trim());
    }
    setRenamingId(null);
    setRenameValue('');
  };

  const handleDeleteClick = (id: string) => {
    if (confirmDeleteId === id) {
      onDelete(id);
      setConfirmDeleteId(null);
      setMenuOpenId(null);
    } else {
      setConfirmDeleteId(id);
    }
  };

  return (
    <div className="flex h-full flex-col bg-surface-container-lowest font-mono">
      <div className="flex items-center justify-between border-b border-outline-variant/60 px-3 py-2">
        <h2 className="text-[12px] uppercase tracking-wider text-on-surface flex items-center gap-1.5">
          <span aria-hidden className="text-outline-variant">▸</span>
          sessions
        </h2>
        <button
          onClick={onCreate}
          className="inline-flex items-center gap-1 rounded-xs px-2 py-0.5 text-[11px] border border-primary/60 bg-primary-container/40 text-primary hover:bg-primary-container transition-colors cursor-pointer"
        >
          <Plus className="h-3 w-3" />
          new
        </button>
      </div>

      <div className="px-2 py-2 border-b border-outline-variant/60">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-outline-variant" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search…"
            className="w-full rounded-xs py-1 pl-7 pr-2 text-[12px] bg-surface-container-low border border-outline-variant/60 text-on-surface placeholder:text-outline-variant focus:outline-none focus:border-primary transition-colors"
          />
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {Object.keys(grouped).length === 0 && (
          <div className="px-3 py-8 text-center text-xs text-on-surface-variant">
            No sessions found
          </div>
        )}

        {GROUP_ORDER.filter((g) => grouped[g]).map((group) => (
          <div key={group} className="mt-1 first:mt-0">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-outline-variant flex items-center gap-1.5">
              <span aria-hidden>▸</span>
              {group.toLowerCase()}
            </div>

            <div>
              {grouped[group].map((session) => {
                const isActive = session.id === activeSessionId;
                const isRenaming = renamingId === session.id;

                return (
                  <div
                    key={session.id}
                    className={cn(
                      'group relative px-2 py-1.5 cursor-pointer transition-colors border-l-2',
                      isActive
                        ? 'border-l-primary bg-primary-container/30'
                        : 'border-l-transparent hover:border-l-outline-variant hover:bg-surface-container-low'
                    )}
                    onClick={() => {
                      if (!isRenaming) onSelect(session.id);
                    }}
                    onDoubleClick={() => handleStartRename(session)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        {isRenaming ? (
                          <input
                            ref={renameInputRef}
                            type="text"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={handleFinishRename}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleFinishRename();
                              if (e.key === 'Escape') {
                                setRenamingId(null);
                                setRenameValue('');
                              }
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full rounded-xs px-1.5 py-0.5 text-[13px] bg-surface-container-low border border-primary text-on-surface focus:outline-none"
                          />
                        ) : (
                          <p
                            className={cn(
                              'truncate text-[13px]',
                              isActive ? 'text-on-surface' : 'text-on-surface-variant'
                            )}
                          >
                            {session.title}
                          </p>
                        )}

                        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-outline">
                          {session.channelType && session.channelType !== 'webchat' && session.channelType !== 'api' && (
                            <span className="inline-flex items-center gap-0.5 text-primary" title={session.channelType}>
                              {session.channelType === 'telegram' ? <Smartphone className="h-2.5 w-2.5" /> :
                               session.channelType === 'slack' ? <Hash className="h-2.5 w-2.5" /> :
                               <Globe className="h-2.5 w-2.5" />}
                              {session.channelType}
                            </span>
                          )}
                          {session.devMode && (
                            <span className="inline-flex items-center gap-0.5 text-tertiary" title={session.projectName}>
                              <Code2 className="h-2.5 w-2.5" />
                              {session.projectName || 'dev'}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-0.5 tabular-nums">
                            <MessageSquare className="h-2.5 w-2.5" />
                            {session.messageCount}
                          </span>
                          <span>· {timeAgo(session.updatedAt)}</span>
                        </div>
                      </div>

                      {!isRenaming && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuOpenId(menuOpenId === session.id ? null : session.id);
                            setConfirmDeleteId(null);
                          }}
                          aria-label="Session actions"
                          className={cn(
                            'mt-0.5 rounded-xs p-0.5 text-outline-variant transition-opacity hover:bg-surface-container hover:text-on-surface',
                            menuOpenId === session.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                          )}
                        >
                          <MoreHorizontal className="h-3 w-3" />
                        </button>
                      )}
                    </div>

                    {/* Dropdown menu */}
                    {menuOpenId === session.id && (
                      <div
                        ref={menuRef}
                        className="absolute right-2 top-8 z-10 min-w-[120px] rounded-xs py-1 bg-surface-container border border-outline-variant shadow-xl"
                      >
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStartRename(session);
                          }}
                          className="flex w-full items-center gap-2 px-2.5 py-1 text-[12px] text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface cursor-pointer"
                        >
                          <Pencil className="h-3 w-3" />
                          rename
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteClick(session.id);
                          }}
                          className={cn(
                            'flex w-full items-center gap-2 px-2.5 py-1 text-[12px] cursor-pointer hover:bg-error-container/40',
                            confirmDeleteId === session.id ? 'text-error' : 'text-on-surface-variant hover:text-error',
                          )}
                        >
                          <Trash2 className="h-3 w-3" />
                          {confirmDeleteId === session.id ? '! confirm?' : 'delete'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
