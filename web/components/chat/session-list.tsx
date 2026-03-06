'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, Search, MessageSquare, Trash2, MoreHorizontal, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';

export interface SessionInfo {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  status: string;
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
    <div className="flex h-full flex-col bg-white dark:bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-3 dark:border-gray-700/60">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Sessions</h2>
        <button
          onClick={onCreate}
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium',
            'bg-primary/10 text-primary hover:bg-primary/20',
            'dark:bg-primary/20 dark:hover:bg-primary/30',
            'transition-colors'
          )}
        >
          <Plus className="h-3.5 w-3.5" />
          New
        </button>
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search sessions..."
            className={cn(
              'w-full rounded-md py-1.5 pl-8 pr-3 text-xs',
              'bg-gray-50 dark:bg-gray-800',
              'text-gray-700 dark:text-gray-300',
              'placeholder:text-gray-400 dark:placeholder:text-gray-500',
              'ring-1 ring-gray-200/60 dark:ring-gray-700/60',
              'focus:outline-none focus:ring-2 focus:ring-primary/40',
              'transition-shadow'
            )}
          />
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {Object.keys(grouped).length === 0 && (
          <div className="px-3 py-8 text-center text-xs text-gray-400 dark:text-gray-500">
            No sessions found
          </div>
        )}

        {GROUP_ORDER.filter((g) => grouped[g]).map((group) => (
          <div key={group} className="mt-2 first:mt-0">
            <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
              {group}
            </div>

            <div className="space-y-0.5">
              {grouped[group].map((session) => {
                const isActive = session.id === activeSessionId;
                const isRenaming = renamingId === session.id;

                return (
                  <div
                    key={session.id}
                    className={cn(
                      'group relative rounded-lg px-3 py-2 cursor-pointer transition-colors',
                      isActive
                        ? 'border-l-2 border-l-primary bg-primary/5 dark:bg-primary/10'
                        : 'border-l-2 border-l-transparent hover:bg-gray-50 dark:hover:bg-gray-800/60'
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
                            className={cn(
                              'w-full rounded px-1.5 py-0.5 text-sm',
                              'bg-white dark:bg-gray-700',
                              'text-gray-800 dark:text-gray-200',
                              'ring-1 ring-primary/50',
                              'focus:outline-none focus:ring-2 focus:ring-primary/60'
                            )}
                          />
                        ) : (
                          <p
                            className={cn(
                              'truncate text-sm',
                              isActive
                                ? 'font-medium text-gray-900 dark:text-gray-100'
                                : 'text-gray-700 dark:text-gray-300'
                            )}
                          >
                            {session.title}
                          </p>
                        )}

                        <div className="mt-0.5 flex items-center gap-2">
                          <span className="inline-flex items-center gap-1 text-[10px] text-gray-400 dark:text-gray-500">
                            <MessageSquare className="h-2.5 w-2.5" />
                            {session.messageCount}
                          </span>
                          <span className="text-[10px] text-gray-400 dark:text-gray-500">
                            {timeAgo(session.updatedAt)}
                          </span>
                        </div>
                      </div>

                      {/* Action menu trigger */}
                      {!isRenaming && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuOpenId(menuOpenId === session.id ? null : session.id);
                            setConfirmDeleteId(null);
                          }}
                          className={cn(
                            'mt-0.5 rounded p-0.5 text-gray-400 transition-opacity',
                            'hover:bg-gray-200/60 hover:text-gray-600',
                            'dark:hover:bg-gray-700/60 dark:hover:text-gray-300',
                            menuOpenId === session.id
                              ? 'opacity-100'
                              : 'opacity-0 group-hover:opacity-100'
                          )}
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>

                    {/* Dropdown menu */}
                    {menuOpenId === session.id && (
                      <div
                        ref={menuRef}
                        className={cn(
                          'absolute right-2 top-9 z-10 min-w-[120px] rounded-md py-1 shadow-lg',
                          'bg-white dark:bg-gray-800',
                          'ring-1 ring-gray-200/60 dark:ring-gray-700/60'
                        )}
                      >
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStartRename(session);
                          }}
                          className={cn(
                            'flex w-full items-center gap-2 px-3 py-1.5 text-xs',
                            'text-gray-700 dark:text-gray-300',
                            'hover:bg-gray-50 dark:hover:bg-gray-700/60'
                          )}
                        >
                          <Pencil className="h-3 w-3" />
                          Rename
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteClick(session.id);
                          }}
                          className={cn(
                            'flex w-full items-center gap-2 px-3 py-1.5 text-xs',
                            confirmDeleteId === session.id
                              ? 'text-red-600 dark:text-red-400 font-medium'
                              : 'text-gray-700 dark:text-gray-300',
                            'hover:bg-gray-50 dark:hover:bg-gray-700/60'
                          )}
                        >
                          <Trash2 className="h-3 w-3" />
                          {confirmDeleteId === session.id ? 'Confirm?' : 'Delete'}
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
