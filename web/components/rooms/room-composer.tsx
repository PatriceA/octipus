'use client';

import { Bot, Send } from 'lucide-react';
import { useRef, useState } from 'react';
import { mentionAt } from '@/lib/rooms';
import { cn } from '@/lib/utils';

/** Clients send at most one `room.typing` per 3 s (the server rate-limits it). */
const TYPING_EVERY_MS = 3_000;

interface RoomComposerProps {
  /** Usernames that `@` completes: the room's members. */
  members: string[];
  /** May ask Octipus (`run_agent`); without it the toggle is off and disabled. */
  canAsk: boolean;
  onPost: (content: string, addressed: boolean) => void;
  onTyping: () => void;
}

/**
 * The room's composer: a textarea (Enter posts, Shift+Enter breaks the
 * line), the "Ask Octipus" toggle (a post without it, or without
 * `@octipus` in the text, is for the members only), and `@` completion of
 * the room's members.
 */
export function RoomComposer({ members, canAsk, onPost, onTyping }: RoomComposerProps) {
  const [text, setText] = useState('');
  const [ask, setAsk] = useState(false);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastTypingRef = useRef(0);

  const mention = mentionAt(text, caret);
  const candidates = mention && dismissedAt !== mention.start
    ? ['octipus', ...members]
      .filter((name, i, all) => all.indexOf(name) === i)
      .filter((name) => name.toLowerCase().startsWith(mention.query.toLowerCase()))
      .slice(0, 8)
    : [];
  const active = Math.min(highlight, Math.max(candidates.length - 1, 0));

  const complete = (name: string) => {
    if (!mention) return;
    const next = `${text.slice(0, mention.start)}@${name} ${text.slice(caret)}`;
    const at = mention.start + name.length + 2;
    setText(next);
    setCaret(at);
    setHighlight(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(at, at);
    });
  };

  const submit = () => {
    const content = text.trim();
    if (!content) return;
    onPost(content, canAsk && ask);
    setText('');
    setCaret(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (candidates.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setHighlight((active + step + candidates.length) % candidates.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        complete(candidates[active]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedAt(mention?.start ?? null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    setCaret(e.target.selectionStart ?? e.target.value.length);
    setHighlight(0);
    const now = Date.now();
    if (e.target.value && now - lastTypingRef.current >= TYPING_EVERY_MS) {
      lastTypingRef.current = now;
      onTyping();
    }
  };

  return (
    <div className="border-t border-outline-variant/60 p-3 bg-surface-container-lowest font-mono">
      <div className="relative">
        {candidates.length > 0 && (
          <ul
            role="listbox"
            aria-label="Mention a member"
            className="absolute bottom-full left-0 mb-1 w-56 max-h-48 overflow-y-auto bg-surface-container border border-outline-variant rounded-xs shadow-xl z-20 text-[12px]"
          >
            {candidates.map((name, i) => (
              <li
                key={name}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => { e.preventDefault(); complete(name); }}
                className={cn('px-2 py-1 cursor-pointer', i === active ? 'bg-primary-container/50 text-primary' : 'text-on-surface hover:bg-surface-container-high')}
              >
                @{name}{name === 'octipus' && <span className="ml-1.5 text-on-surface-variant">ask the agent</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={text}
            rows={Math.min(6, Math.max(1, text.split('\n').length))}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            placeholder={ask ? 'ask octipus — everyone in the room sees the answer…' : 'message the room — @ to mention…'}
            aria-label="Message the room"
            className="flex-1 resize-none px-3 py-2 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[13px] text-on-surface placeholder-outline-variant focus:outline-none focus:border-primary"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!text.trim()}
            className="h-9 px-3 rounded-xs bg-primary text-on-primary cursor-pointer hover:bg-primary-dim disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 text-[12px]"
          >
            <Send className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">post</span>
          </button>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-3 text-[11px] text-on-surface-variant">
        <button
          type="button"
          role="switch"
          aria-checked={canAsk && ask}
          disabled={!canAsk}
          onClick={() => setAsk((v) => !v)}
          title={canAsk ? 'Your post asks Octipus; the answer is posted in the room' : 'Your role cannot run the agent'}
          className={cn(
            'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-xs border cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed',
            canAsk && ask ? 'border-primary text-primary bg-primary-container/40' : 'border-outline-variant/60 hover:text-on-surface',
          )}
        >
          <Bot className="w-3.5 h-3.5" /> Ask Octipus
        </button>
        <span className="hidden sm:inline">or write @octipus · commands start with /</span>
      </div>
    </div>
  );
}
