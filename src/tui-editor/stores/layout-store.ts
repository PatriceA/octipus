/**
 * Layout / focus state for the editor shell.
 *
 * Pure state container — no React dependency — so the store stays
 * unit-testable without mounting the UI. Components subscribe via a
 * tiny `useStore(store, selector)` hook (defined alongside).
 */
export type PaneId = 'tree' | 'editor' | 'chat';
export type OverlayId =
  | { kind: 'palette' }
  | { kind: 'file-picker' }
  | { kind: 'workspace-picker' }
  | { kind: 'goto-line' }
  | { kind: 'find' }
  | { kind: 'replace' }
  | { kind: 'help' }
  | null;

export type EditorMode = 'modeless' | 'vim';

export interface LayoutState {
  treeVisible: boolean;
  chatVisible: boolean;
  focused: PaneId;
  overlay: OverlayId;
  /** Last terminal size we know about — used by editor scroll math. */
  cols: number;
  rows: number;
  /**
   * Editor input mode. `'modeless'` (default) routes every
   * keystroke to the buffer's modeless handler. `'vim'` routes
   * NORMAL/VISUAL keystrokes through `editor/vim.ts`; INSERT mode
   * falls through to the modeless path so typing feels unchanged.
   */
  editorMode: EditorMode;
}

export type LayoutListener = (s: LayoutState) => void;

export class LayoutStore {
  private state: LayoutState = {
    treeVisible: true,
    chatVisible: true,
    focused: 'editor',
    overlay: null,
    cols: 120,
    rows: 30,
    editorMode: 'modeless',
  };
  private listeners = new Set<LayoutListener>();

  get(): LayoutState { return this.state; }

  subscribe(fn: LayoutListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<LayoutState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  toggleTree(): void { this.set({ treeVisible: !this.state.treeVisible }); }
  toggleChat(): void { this.set({ chatVisible: !this.state.chatVisible }); }

  /**
   * Cycle focus across the visible panes. Hidden panes are skipped
   * so Ctrl+\\ never lands on something the user can't see.
   */
  cycleFocus(direction: 1 | -1 = 1): void {
    const order: PaneId[] = [];
    if (this.state.treeVisible) order.push('tree');
    order.push('editor');
    if (this.state.chatVisible) order.push('chat');
    if (order.length === 0) return;
    const i = order.indexOf(this.state.focused);
    const next = order[(i + direction + order.length) % order.length];
    this.set({ focused: next });
  }

  focus(p: PaneId): void { this.set({ focused: p }); }

  openOverlay(o: OverlayId): void { this.set({ overlay: o }); }
  closeOverlay(): void { this.set({ overlay: null }); }

  setSize(cols: number, rows: number): void { this.set({ cols, rows }); }

  setEditorMode(mode: EditorMode): void { this.set({ editorMode: mode }); }
}
