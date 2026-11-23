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
  commit?: () => void;
}

/**
 * One quiet "Done · Undo" line at the bottom of the screen. Two shapes:
 *
 *  - `show(message, undo)`: the change has already been made on the server;
 *    Undo is a second request that reverses it (an archived note).
 *  - `show(message, undo, commit)`: the change is only shown; `commit` makes
 *    it once the offer closes without Undo — on timeout, Dismiss, a newer
 *    offer, leaving the page (unmount) or the tab closing (`pagehide`, best
 *    effort: a request lost then leaves the item as it was). Undo then sends
 *    nothing, so a change with side effects (a to-do's checkout, its
 *    completion time, the wake-ups of what waited on it) never happens.
 *
 * Returns `show` and the element to render once in the page.
 */
export function useUndoToast(timeoutMs = UNDO_TOAST_MS): {
  show: (message: string, undo: () => void, commit?: () => void) => void;
  toast: ReactNode;
} {
  const [offer, setOffer] = useState<UndoOffer | null>(null);
  const offerRef = useRef<UndoOffer | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  /** Close the current offer; without `undone`, make its change. */
  const close = useCallback((undone: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const current = offerRef.current;
    offerRef.current = null;
    setOffer(null);
    if (!current) return;
    if (undone) current.undo();
    else current.commit?.();
  }, []);

  const show = useCallback((message: string, undo: () => void, commit?: () => void) => {
    close(false);
    seq.current += 1;
    const next = { key: seq.current, message, undo, commit };
    offerRef.current = next;
    setOffer(next);
    timer.current = setTimeout(() => close(false), timeoutMs);
  }, [close, timeoutMs]);

  useEffect(() => {
    const onPageHide = () => close(false);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      // Leaving the page: what was on offer stands.
      if (timer.current) clearTimeout(timer.current);
      const current = offerRef.current;
      offerRef.current = null;
      current?.commit?.();
    };
  }, [close]);

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
          <button type="button" onClick={() => close(true)} className="shrink-0 font-medium text-primary hover:underline">
            Undo
          </button>
          <button type="button" onClick={() => close(false)} aria-label="Dismiss" className="shrink-0 text-on-surface-variant hover:text-on-surface">
            <X size={14} />
          </button>
        </div>
      </div>
    </Portal>
  ) : null;

  return { show, toast };
}
