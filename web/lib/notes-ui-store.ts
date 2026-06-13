import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Persisted layout state for the notes workspace — pane widths and whether the
 * right context panel is collapsed. Mirrors the `useSidebarStore` pattern so
 * the workspace remembers how the user sized it across navigations.
 */
interface NotesUiState {
  navWidth: number;
  ctxWidth: number;
  ctxCollapsed: boolean;
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
      navWidth: 288,
      ctxWidth: 312,
      ctxCollapsed: false,
      setNavWidth: (navWidth) => set({ navWidth: Math.min(NAV_MAX, Math.max(NAV_MIN, navWidth)) }),
      setCtxWidth: (ctxWidth) => set({ ctxWidth: Math.min(CTX_MAX, Math.max(CTX_MIN, ctxWidth)) }),
      toggleCtx: () => set((s) => ({ ctxCollapsed: !s.ctxCollapsed })),
      setCtxCollapsed: (ctxCollapsed) => set({ ctxCollapsed }),
    }),
    { name: 'notes-ui' },
  ),
);
