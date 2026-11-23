'use client';

import { X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Portal } from './portal';

/** How long an undo stays on offer before the change is final. */
export const UNDO_TOAST_MS = 8000;

interface UndoOffer {
  key: number;
  message: string;
  undo: () => void;
}

/**
 * One quiet "Done · Undo" line at the bottom of the screen, for a change that
 * has already been made and can be taken back (an archived note, a removed
 * to-do). Showing a new one replaces the previous offer, which then simply
 * stands. The change itself is never deferred: the server already has it, so
 * closing the tab loses nothing; Undo is a second request that reverses it.
 *
 * Returns `show(message, undo)` and the element to render once in the page.
 */
export function useUndoToast(timeoutMs = UNDO_TOAST_MS): {
  show: (message: string, undo: () => void) => void;
  toast: ReactNode;
} {
  const [offer, setOffer] = useState<UndoOffer | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setOffer(null);
  }, []);

  const show = useCallback((message: string, undo: () => void) => {
    if (timer.current) clearTimeout(timer.current);
    seq.current += 1;
    setOffer({ key: seq.current, message, undo });
    timer.current = setTimeout(() => {
      timer.current = null;
      setOffer(null);
    }, timeoutMs);
  }, [timeoutMs]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const toast = offer ? (
    <Portal>
      <div className="fixed inset-x-0 bottom-4 z-50 flex justify-center px-4 pointer-events-none">
        <div
          key={offer.key}
          role="status"
          aria-live="polite"
          data-testid="undo-toast"
          className="pointer-events-auto flex max-w-full items-center gap-3 rounded-md border border-outline-variant/40 bg-surface-container-high px-4 py-2 text-sm text-on-surface shadow-lg"
        >
          <span className="min-w-0 truncate">{offer.message}</span>
          <button
            type="button"
            onClick={() => {
              const { undo } = offer;
              clear();
              undo();
            }}
            className="shrink-0 font-medium text-primary hover:underline"
          >
            Undo
          </button>
          <button type="button" onClick={clear} aria-label="Dismiss" className="shrink-0 text-on-surface-variant hover:text-on-surface">
            <X size={14} />
          </button>
        </div>
      </div>
    </Portal>
  ) : null;

  return { show, toast };
}
