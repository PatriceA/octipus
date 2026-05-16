'use client';

import { Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface SessionTab {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  status: string;
}

interface SessionTabsProps {
  sessions: SessionTab[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onClose: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

/**
 * Tab-bar styled as TUI buffer chips. The active tab carries a top
 * accent stripe + filled surface; inactive tabs are dim, hover
 * brightens. Double-click to rename, single click to switch, X to
 * close. Plus button at the end opens a new buffer.
 */
export function SessionTabs({ sessions, activeSessionId, onSelect, onCreate, onClose, onRename }: SessionTabsProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const startRename = (id: string, currentTitle: string) => {
    setEditingId(id);
    setEditValue(currentTitle);
  };

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      onRename(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  return (
    <div className="flex items-stretch gap-0 overflow-x-auto font-mono border-b border-outline-variant/60">
      {sessions.map((session) => {
        const isActive = session.id === activeSessionId;
        return (
          <div
            key={session.id}
            className={cn(
              'group flex items-center gap-1.5 px-3 py-1.5 text-[12px] cursor-pointer transition-colors min-w-0 max-w-[200px] border-r border-outline-variant/60 border-t-2',
              isActive
                ? 'bg-surface-container border-t-primary text-on-surface'
                : 'bg-surface-container-lowest border-t-transparent text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low',
            )}
            onClick={() => onSelect(session.id)}
            onDoubleClick={() => startRename(session.id, session.title || 'Untitled')}
          >
            {isActive && (
              <span aria-hidden className="text-primary text-[11px]">●</span>
            )}
            {editingId === session.id ? (
              <input
                ref={inputRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setEditingId(null);
                }}
                className="bg-transparent border-none outline-hidden text-[12px] w-full min-w-[60px] font-mono"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="truncate">{session.title || 'untitled'}</span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(session.id);
              }}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded-xs hover:bg-surface-container-highest text-outline-variant hover:text-on-surface transition-opacity shrink-0"
              aria-label="Close session"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        );
      })}
      <button
        onClick={onCreate}
        className="flex items-center gap-1 px-3 py-1.5 text-[12px] text-outline-variant hover:text-primary hover:bg-surface-container-low transition-colors shrink-0 border-r border-outline-variant/60"
        title="New session"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
