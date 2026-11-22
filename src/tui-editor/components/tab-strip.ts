/**
 * Tab strip rendering one tab per open buffer. Active tab is
 * inverted; dirty buffers are marked with a leading bullet, and every tab
 * ends with a close marker (`×`).
 *
 * Keyboard navigation lives in the editor keymap (Alt+. / Alt+, cycle,
 * Ctrl+W closes). With the mouse, a click on a tab activates it and a
 * click on its `×` closes it (`onClose`, which asks about unsaved changes).
 */
import { type Component, truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth } from '@/tui-kit';
import type { BufferStore } from '../stores/buffer-store';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

export interface TabStripOptions {
  /** The close marker of a tab was clicked. */
  onClose?: (bufferId: string) => void;
}

/** Where each tab was drawn: [start, end) cells, and the cell of its close marker. */
interface TabCells { id: string; start: number; end: number; close: number }

export class TabStrip implements Component {
  private cells: TabCells[] = [];

  constructor(private readonly buffers: BufferStore, private readonly options: TabStripOptions = {}) {}

  invalidate(): void { /* state is sourced from the store */ }

  render(width: number): string[] {
    const palette = getPalette();
    const state = this.buffers.get();
    this.cells = [];
    if (state.buffers.length === 0) {
      return [chalk.hex(palette.dim)(' (no buffers) ')];
    }
    let at = 0;
    const tabs = state.buffers.map((b, i) => {
      const dirty = b.dirty ? '● ' : '';
      const label = ` ${dirty}${b.label} `;
      const close = '× ';
      const start = at + (i > 0 ? 1 : 0);
      const labelWidth = visibleWidth(label);
      this.cells.push({ id: b.id, start, end: start + labelWidth + 2, close: start + labelWidth });
      at = start + labelWidth + 2;
      const isActive = b.id === state.activeId;
      return isActive
        ? chalk.bgHex(palette.accent).hex(palette.cursorFg)(label + close)
        : chalk.hex(palette.statusFg)(label) + chalk.hex(palette.dim)(close);
    });
    return [truncateToWidth(tabs.join(chalk.hex(palette.dim)('│')), width)];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'click' || event.button !== 'left') return { handled: true };
    const tab = this.cells.find((t) => event.x >= t.start && event.x < t.end);
    if (!tab) return { handled: true };
    if (event.x >= tab.close) this.options.onClose?.(tab.id);
    else this.buffers.setActive(tab.id);
    return { handled: true };
  }
}
