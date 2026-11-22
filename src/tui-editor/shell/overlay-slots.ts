/**
 * The editor's overlays by name: at most one of each is open, and each
 * knows how to close.
 *
 * Every overlay used to have its own handle field and its own close method
 * on the app; they differed only in whether focus went back to the pane
 * always or only when no other overlay was left open (a prompt raised while
 * another is waiting must not steal its focus).
 */
import type { Component, OverlayHandle, OverlayOptions, TUI } from '@/tui-kit';
import type { CommandPaletteOptions } from '@/tui-pi/components/command-palette';
import type { OverlayController } from '@/tui-pi/overlays/registry';

export type OverlaySlot =
  | 'palette' | 'hotkeys' | 'filePicker' | 'find' | 'replace' | 'workspace' | 'mcp' | 'saveAs'
  | 'prompt' | 'diff' | 'unsaved' | 'external';

/** The overlays a new app-level overlay replaces (stack discipline: one app overlay at a time). */
export const APP_OVERLAYS: readonly OverlaySlot[] = ['palette', 'hotkeys', 'filePicker', 'find', 'replace', 'workspace', 'mcp', 'saveAs', 'prompt'];

export class OverlaySlots {
  private readonly handles = new Map<OverlaySlot, OverlayHandle>();
  /** Overlays whose content is still being fetched: a second key press must not open a second one. */
  readonly loading = new Set<OverlaySlot>();

  constructor(
    private readonly controller: OverlayController,
    private readonly tui: Pick<TUI, 'hasOverlay'>,
    private readonly refocus: () => void,
  ) {}

  isOpen(slot: OverlaySlot): boolean { return this.handles.has(slot); }

  show(slot: OverlaySlot, component: Component, options?: OverlayOptions): void {
    this.handles.set(slot, this.controller.showModal(component, options));
  }

  showPalette(options: CommandPaletteOptions): void {
    this.handles.set('palette', this.controller.showCommandPalette(options));
  }

  /** Hide `slot` without touching focus; returns whether it was open. */
  hide(slot: OverlaySlot): boolean {
    const handle = this.handles.get(slot);
    if (!handle) return false;
    handle.hide();
    this.handles.delete(slot);
    return true;
  }

  /**
   * Hide `slot` and give the focus back to the focused pane: `always`, or
   * only when no other overlay is still open (`ifNoneLeft`).
   */
  close(slot: OverlaySlot, refocus: 'always' | 'ifNoneLeft' = 'always'): boolean {
    if (!this.hide(slot)) return false;
    if (refocus === 'always' || !this.tui.hasOverlay()) this.refocus();
    return true;
  }

  hideAll(slots: readonly OverlaySlot[]): void {
    for (const slot of slots) this.hide(slot);
  }
}
