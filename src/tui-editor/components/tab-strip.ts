/**
 * Tab strip rendering one tab per open buffer. Active tab is
 * inverted; dirty buffers are marked with a leading bullet.
 *
 * The strip is read-only — keyboard navigation lives in the editor
 * keymap (Ctrl+Tab cycles, Ctrl+W closes). Mouse support could come
 * later but pi-tui doesn't expose it yet.
 */
import { type Component, truncateToWidth } from '@mariozechner/pi-tui';
import type { BufferStore } from '../stores/buffer-store';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

export class TabStrip implements Component {
  constructor(private readonly buffers: BufferStore) {}

  invalidate(): void { /* state is sourced from the store */ }

  render(width: number): string[] {
    const palette = getPalette();
    const state = this.buffers.get();
    if (state.buffers.length === 0) {
      return [chalk.hex(palette.dim)(' (no buffers) ')];
    }
    const tabs = state.buffers.map((b) => {
      const dirty = b.dirty ? '● ' : '';
      const label = ` ${dirty}${b.label} `;
      const isActive = b.id === state.activeId;
      return isActive
        ? chalk.bgHex(palette.accent).hex(palette.cursorFg)(label)
        : chalk.hex(palette.statusFg)(label);
    });
    return [truncateToWidth(tabs.join(chalk.hex(palette.dim)('│')), width)];
  }
}
