/**
 * Bottom status / mode bar. One line: editor mode, language, cursor
 * position, dirty/lock indicators, focused pane, and (when vim is
 * active) the current vim sub-mode.
 */
import { type Component, truncateToWidth } from '@mariozechner/pi-tui';
import type { BufferStore } from '../stores/buffer-store';
import type { LayoutStore } from '../stores/layout-store';
import type { VimMode } from '../editor/vim';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

export interface ModeBarOptions {
  /** Optional read-back of the editor's vim sub-mode for the badge. */
  getVimMode?: () => VimMode;
}

export class ModeBar implements Component {
  constructor(
    private readonly layout: LayoutStore,
    private readonly buffers: BufferStore,
    private readonly options: ModeBarOptions = {},
  ) {}

  invalidate(): void { /* sourced from the stores */ }

  render(width: number): string[] {
    const palette = getPalette();
    const layout = this.layout.get();
    const active = this.buffers.active();
    const parts: string[] = [];
    parts.push(chalk.bold.hex(palette.accent)(this.modeBadge(layout.editorMode)));
    parts.push(chalk.hex(palette.dim)(`focus:${layout.focused}`));
    if (active) {
      const cursor = active.buffer.getCursor();
      parts.push(chalk.hex(palette.statusFg)(`${active.label}${active.dirty ? ' ●' : ''}`));
      parts.push(chalk.hex(palette.dim)(active.language));
      parts.push(chalk.hex(palette.dim)(`L${cursor.line + 1}:${cursor.col + 1}`));
      if (active.agentLocked) parts.push(chalk.hex(palette.warn)('agent-lock'));
    }
    return [truncateToWidth(parts.join('  '), width)];
  }

  private modeBadge(mode: 'modeless' | 'vim'): string {
    if (mode !== 'vim') return 'INS';
    const sub = this.options.getVimMode?.() ?? 'NORMAL';
    return sub === 'NORMAL' ? 'VIM·N' : sub === 'VISUAL' ? 'VIM·V' : 'VIM·I';
  }
}
