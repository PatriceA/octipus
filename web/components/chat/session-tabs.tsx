'use client';

import { useState, useRef, useEffect } from 'react';
import { Plus, X } from 'lucide-react';
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
    <div className="flex items-center gap-1 overflow-x-auto scrollbar-thin pb-1">
      {sessions.map((session) => (
        <div
          key={session.id}
          className={cn(
            'group flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm cursor-pointer transition-colors min-w-0 max-w-[200px]',
            session.id === activeSessionId
              ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 ring-1 ring-blue-200 dark:ring-blue-800'
              : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50',
          )}
          onClick={() => onSelect(session.id)}
          onDoubleClick={() => startRename(session.id, session.title || 'Untitled')}
        >
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
              className="bg-transparent border-none outline-none text-sm w-full min-w-[60px]"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="truncate">{session.title || 'Untitled'}</span>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose(session.id);
            }}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-opacity flex-shrink-0"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
      <button
        onClick={onCreate}
        className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors flex-shrink-0"
        title="New session"
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
}
