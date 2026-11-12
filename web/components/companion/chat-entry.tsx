'use client';

import Link from 'next/link';
import { Sparkles } from 'lucide-react';

export function CompanionChatEntry({ sessionId, active = false, onOpen, compact = false }: {
  sessionId?: string | null; active?: boolean; onOpen?: (id: string) => void; compact?: boolean;
}) {
  const content = <>
    <span className="flex items-center gap-2 font-semibold text-secondary"><Sparkles className="h-4 w-4 shrink-0" aria-hidden />Companion chat</span>
    <span className="mt-1 block text-xs leading-relaxed text-on-secondary-container">{compact ? 'Your coordinator across projects' : 'Plan across projects, follow progress, and park ideas for later.'}</span>
    {!compact && <span className="mt-2 block text-xs text-on-secondary-container">Optional: you can always work directly in a session chat.</span>}
    <span className="mt-2 block text-xs font-medium text-secondary">{sessionId ? 'Open Companion chat →' : 'Set up Companion →'}</span>
  </>;
  const className = `companion-chat-entry block w-full rounded-lg border p-3 text-left font-sans transition-colors ${active ? 'border-secondary bg-secondary-container ring-1 ring-secondary/40' : 'border-secondary/30 bg-secondary-container hover:border-secondary/70'}`;
  return sessionId && onOpen
    ? <button type="button" data-session-id={sessionId} aria-current={active ? 'page' : undefined} aria-label="Open Companion chat" className={className} onClick={() => onOpen(sessionId)}>{content}</button>
    : <Link className={className} href={sessionId ? `/chat?session=${sessionId}` : '/companion'}>{content}</Link>;
}
