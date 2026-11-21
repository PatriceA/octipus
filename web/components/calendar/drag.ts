import type { PointerEvent as ReactPointerEvent } from 'react';

/** Pointer travel before a press counts as a drag. */
export const DRAG_PX = 5;
/** A finger has to rest this long on an event before it can be dragged: a quick swipe still scrolls. */
export const LONG_PRESS_MS = 350;

interface DragHandlers {
  /** The pointer moved while dragging. */
  onMove: (event: PointerEvent) => void;
  /** The press ended. `dropped`: it was a drag and the pointer was let go (not cancelled). */
  onEnd: (dropped: boolean) => void;
  /** A finger has rested long enough: the event is picked up. */
  onPickUp?: () => void;
}

/**
 * Follow one press on an event until it ends. With a mouse or a pen the drag
 * starts once the pointer has moved a few pixels. With a finger it starts
 * only after a long press; a finger that moves sooner is scrolling, and the
 * press is let go so the page scrolls as usual. Once a finger has picked the
 * event up, the page does not scroll under it.
 *
 * Returns a function that drops the press without a drop (the grid went away).
 */
export function beginDrag(press: ReactPointerEvent, handlers: DragHandlers): () => void {
  const touch = press.pointerType === 'touch';
  const origin = { x: press.clientX, y: press.clientY };
  const id = press.pointerId;
  let state: 'pressing' | 'holding' | 'dragging' = touch ? 'pressing' : 'holding';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;

  const blockScroll = (event: TouchEvent) => { if (state !== 'pressing') event.preventDefault(); };
  const finish = (dropped: boolean) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('touchmove', blockScroll);
    handlers.onEnd(dropped);
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== id) return;
    const far = Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > DRAG_PX;
    if (state === 'pressing') { if (far) finish(false); return; }
    if (state === 'holding') {
      // A held finger drags at once; a mouse only once it has really moved.
      if (!touch && !far) return;
      state = 'dragging';
    }
    handlers.onMove(event);
  };
  const up = (event: PointerEvent) => { if (event.pointerId === id) finish(state === 'dragging'); };
  const cancel = (event: PointerEvent) => { if (event.pointerId === id) finish(false); };

  if (touch) {
    timer = setTimeout(() => {
      if (done) return;
      state = 'holding';
      handlers.onPickUp?.();
      try { navigator.vibrate?.(10); } catch { /* not every device can */ }
    }, LONG_PRESS_MS);
    window.addEventListener('touchmove', blockScroll, { passive: false });
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  return () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('touchmove', blockScroll);
  };
}
