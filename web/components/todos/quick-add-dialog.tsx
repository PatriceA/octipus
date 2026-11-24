'use client';

import { ListTodo, Sun } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useUndoToast } from '@/components/ui/undo-toast';
import { api } from '@/lib/api';
import { usePageOn } from '@/lib/modules';
import { useWorkspace } from '@/lib/workspace-context';
import { CaptureChips, todoFromCapture, useCaptureParse } from './capture-bar';
import { browserTimezone, type Todo } from './model';
import { pageShortcutAllowed } from '@/lib/shortcut-guard';

/** Dispatch on `window` to open the quick-add, optionally prefilled: `{ detail: { text } }`. */
export const QUICK_ADD_TODO_EVENT = 'octipus:quick-add-todo';

/** Open the global quick-add from anywhere (the Ctrl+K menu, a button). */
export function openQuickAddTodo(text = ''): void {
  window.dispatchEvent(new CustomEvent(QUICK_ADD_TODO_EVENT, { detail: { text } }));
}

/**
 * Add a to-do from anywhere: press Q (outside a text field) or pick "Add
 * to-do" in the Ctrl+K search. One line, read by the same parser as the
 * to-do page (chips show what it understood); Enter adds it to the current
 * workspace's list, with an Undo.
 */
export function QuickAddTodo() {
  const { activeWorkspace } = useWorkspace();
  // The to-dos page turned off (modules): no quick-add either.
  const enabled = usePageOn()('/tasks');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [myDay, setMyDay] = useState(false);
  const [lists, setLists] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { show, toast } = useUndoToast();
  const parsed = useCaptureParse(text, lists);
  const remote = activeWorkspace?.kind === 'remote';
  const shared = activeWorkspace?.kind === 'shared';

  const start = useCallback((prefill: string) => {
    setText(prefill);
    setError('');
    setOpen(true);
    // The lists `#name` is matched against: the active to-dos' lists.
    api.get<{ tasks: Todo[] }>('/tasks?doneLimit=0')
      .then((r) => setLists([...new Set((r.tasks ?? []).map((t) => t.category).filter((c): c is string => !!c))]))
      .catch(() => setLists([]));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'q' || !pageShortcutAllowed(e)) return;
      e.preventDefault();
      start('');
    };
    const onOpen = (e: Event) => start(((e as CustomEvent<{ text?: string }>).detail?.text ?? '').trim());
    document.addEventListener('keydown', onKey);
    window.addEventListener(QUICK_ADD_TODO_EVENT, onOpen);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener(QUICK_ADD_TODO_EVENT, onOpen);
    };
  }, [enabled, start]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      inputRef.current?.focus();
    } else if (!open && dialog.open) dialog.close();
  }, [open]);

  const submit = async () => {
    if (!parsed || busy || remote) return;
    setBusy(true);
    setError('');
    try {
      const created = await api.post<Todo>('/tasks', { ...todoFromCapture(parsed), ...(myDay && !shared ? { myDay: true } : {}), tz: browserTimezone() });
      setText('');
      setOpen(false);
      show(`Added “${created.title}” to your to-dos`, () => { void api.patch(`/tasks/${created.id}`, { status: 'archived' }).catch((err: Error) => setError(err.message)); });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <dialog
        ref={dialogRef}
        aria-label="Add a to-do"
        data-testid="quick-add-todo"
        onClose={() => setOpen(false)}
        onCancel={(e) => { e.preventDefault(); setOpen(false); }}
        onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        className="m-auto mt-[14vh] w-[calc(100%-2rem)] max-w-xl overflow-visible rounded-xl border border-outline-variant bg-surface-container p-0 text-on-surface shadow-2xl backdrop:bg-black/40"
      >
        <div className="flex items-center gap-3 px-4">
          <ListTodo className="h-5 w-5 shrink-0 text-primary" aria-hidden />
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }}
            aria-label="New to-do"
            placeholder="Add a to-do — try “call dentist tomorrow 3pm !high #personal”"
            className="h-14 min-w-0 flex-1 bg-transparent text-base text-on-surface placeholder:text-on-surface-variant/80 focus:outline-none"
          />
        </div>
        <CaptureChips parsed={parsed} className="px-4 pb-3 pl-12" />
        <div className="flex items-center gap-3 border-t border-outline-variant px-4 py-2.5 text-sm">
          {!shared && (
            <label className="inline-flex cursor-pointer items-center gap-2 text-on-surface-variant">
              <input type="checkbox" checked={myDay} onChange={(e) => setMyDay(e.target.checked)} className="h-4 w-4 accent-[var(--color-primary)]" />
              <Sun className="h-4 w-4" aria-hidden /> Add to My Day
            </label>
          )}
          <span className="flex-1" />
          {remote && <span className="text-on-surface-variant">Not available in a space on another install.</span>}
          <kbd className="hidden rounded border border-outline-variant px-1.5 text-xs text-on-surface-variant sm:inline">Enter</kbd>
          <button type="button" disabled={!parsed || busy || remote} onClick={() => void submit()}
            className="rounded-lg bg-primary px-4 py-2 font-semibold text-on-primary disabled:opacity-50">Add</button>
        </div>
        {error && <p role="alert" className="px-4 pb-3 text-sm text-error">{error}</p>}
      </dialog>
      {toast}
    </>
  );
}
