import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { NoteSort } from '@/app/notes/types';

/**
 * Persisted layout state for the notes workspace — pane widths and whether the
 * right context panel is collapsed. Mirrors the `useSidebarStore` pattern so
 * the workspace remembers how the user sized it across navigations.
 */
interface NotesUiState {
  navWidth: number;
  ctxWidth: number;
  ctxCollapsed: boolean;
  /** The list's layout (Recent by default). */
  sort: NoteSort;
  setSort: (sort: NoteSort) => void;
  setNavWidth: (w: number) => void;
  setCtxWidth: (w: number) => void;
  toggleCtx: () => void;
  setCtxCollapsed: (v: boolean) => void;
}

export const NAV_MIN = 220;
export const NAV_MAX = 460;
export const CTX_MIN = 240;
export const CTX_MAX = 520;

export const useNotesUiStore = create<NotesUiState>()(
  persist(
    (set) => ({
      navWidth: 320,
      ctxWidth: 312,
      // The links panel is a secondary view: closed until asked for.
      ctxCollapsed: true,
      sort: 'recent',
      setSort: (sort) => set({ sort }),
      setNavWidth: (navWidth) => set({ navWidth: Math.min(NAV_MAX, Math.max(NAV_MIN, navWidth)) }),
      setCtxWidth: (ctxWidth) => set({ ctxWidth: Math.min(CTX_MAX, Math.max(CTX_MIN, ctxWidth)) }),
      toggleCtx: () => set((s) => ({ ctxCollapsed: !s.ctxCollapsed })),
      setCtxCollapsed: (ctxCollapsed) => set({ ctxCollapsed }),
    }),
    // v1: the links panel starts closed (a stored v0 had it open by default).
    { name: 'notes-ui', version: 1, migrate: (stored) => ({ ...(stored as object), ctxCollapsed: true }) as NotesUiState },
  ),
);
