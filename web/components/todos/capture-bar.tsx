'use client';

import { CalendarDays, Clock, Flag, Hash, Plus, Repeat, Star, X } from 'lucide-react';
import { forwardRef, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { parseQuickAdd, type ParsedQuickAdd, type QuickAddTokenKind, quickAddDueAt } from '../../../src/core/tasks/quick-add';
import { browserTimezone } from './model';
import type { NewTodo } from './use-todos';

const TOKEN_ICON: Record<QuickAddTokenKind, typeof Clock> = {
  due: CalendarDays,
  time: Clock,
  repeat: Repeat,
  priority: Flag,
  important: Star,
  list: Hash,
};

/** What a capture line becomes, before the list it was typed in adds its own defaults. */
export function todoFromCapture(parsed: ParsedQuickAdd): NewTodo {
  return {
    title: parsed.title,
    dueAt: quickAddDueAt(parsed.due, browserTimezone()),
    ...(parsed.priority ? { priority: parsed.priority } : {}),
    ...(parsed.category ? { category: parsed.category } : {}),
    ...(parsed.important ? { important: true } : {}),
    ...(parsed.repeat ? { repeat: parsed.repeat } : {}),
  };
}

/** Parse a line the way the server would (core/tasks/quick-add.ts), in this browser's zone. */
export function useCaptureParse(text: string, lists: readonly string[]): ParsedQuickAdd | null {
  return useMemo(() => (text.trim() ? parseQuickAdd(text, { timezone: browserTimezone(), lists }) : null), [text, lists]);
}

/** The chips a parse produced, each removable (it leaves the line). */
export function CaptureChips({ parsed, onRemove, className }: { parsed: ParsedQuickAdd | null; onRemove?: (start: number, end: number) => void; className?: string }) {
  if (!parsed || parsed.tokens.length === 0) return null;
  return (
    <ul className={cn('flex flex-wrap gap-1.5', className)} aria-label="Understood" data-testid="capture-chips">
      {parsed.tokens.map((t) => {
        const Icon = TOKEN_ICON[t.kind];
        return (
          <li key={`${t.start}-${t.kind}`} data-kind={t.kind}
            className={cn('inline-flex items-center gap-1 rounded-full py-0.5 pl-2 text-xs font-medium',
              onRemove ? 'pr-0.5' : 'pr-2',
              t.kind === 'priority' && t.label === 'High' ? 'bg-error-container text-on-error-container' : 'bg-primary-container text-on-primary-container')}>
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {t.kind === 'list' ? t.label.replace(/^#/, '') : t.kind === 'due' && parsed.due?.time && !parsed.tokens.some((x) => x.kind === 'time') ? `${t.label} ${parsed.due.time}` : t.label}
            {onRemove && (
              <button type="button" aria-label={`Remove ${t.label}`} onClick={() => onRemove(t.start, t.end)}
                className="ml-0.5 rounded-full p-0.5 opacity-70 hover:bg-black/10 hover:opacity-100">
                <X className="h-3 w-3" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The one-line capture of a list: type, Enter adds, focus stays. Dates,
 * times, `!priority`, `#list`, `*` and repeats are read as you type and shown
 * as chips under the line before it is added.
 */
export const CaptureBar = forwardRef<HTMLInputElement, {
  lists: readonly string[];
  placeholder?: string;
  onAdd: (todo: NewTodo) => Promise<unknown>;
}>(function CaptureBar({ lists, placeholder = 'Add a to-do', onAdd }, ref) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const parsed = useCaptureParse(text, lists);
  const submit = async () => {
    if (!parsed || busy) return;
    setBusy(true);
    const sent = text;
    setText('');
    try {
      const ok = await onAdd(todoFromCapture(parsed));
      // A failed add (the error shows) puts the line back.
      if (ok === undefined) setText((now) => now || sent);
    } finally {
      setBusy(false);
    }
  };
  const removeToken = (start: number, end: number) => setText((t) => `${t.slice(0, start)}${t.slice(end)}`.replace(/\s+/g, ' ').trimStart());
  return (
    <div className="todo-capture" data-testid="task-quick-add">
      <div className="flex items-center gap-3 px-4">
        <Plus className="h-5 w-5 shrink-0 text-primary" aria-hidden />
        <input
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
            if (e.key === 'Escape') { setText(''); e.currentTarget.blur(); }
          }}
          aria-label="Add a to-do"
          placeholder={placeholder}
          className="h-12 min-w-0 flex-1 bg-transparent text-[15px] text-on-surface placeholder:text-on-surface-variant/80 focus:outline-none"
        />
        {text.trim() && (
          <button type="button" onClick={() => void submit()} disabled={busy}
            className="shrink-0 rounded-md px-3 py-1.5 text-sm font-semibold text-primary hover:bg-primary-container/60 disabled:opacity-50">
            Add
          </button>
        )}
      </div>
      <CaptureChips parsed={parsed} onRemove={removeToken} className="px-4 pb-3 pl-12" />
    </div>
  );
});
