/**
 * Bottom status / mode bar. One line: editor mode (EDIT, or VIM with its
 * sub-mode and the `:` command being typed), focused pane, buffer, language,
 * cursor position, dirty/lock indicators, and what waits for the resolve key
 * (a file changed on disk, an agent edit to review). A notice replaces the line: an
 * informational one until the next key, an error until the next notice; a
 * failed recovery checkpoint replaces it until a checkpoint succeeds.
 */
import { type Component, displayLine, truncateToWidth } from '@/tui-kit';
import type { BufferStore } from '../stores/buffer-store';
import type { LayoutStore } from '../stores/layout-store';
import type { VimMode } from '../editor/vim';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

export interface ModeBarOptions {
  /** Optional read-back of the editor's vim sub-mode for the badge. */
  getVimMode?: () => VimMode;
  /** The vim `:` command being typed, or null. */
  getVimCommandLine?: () => string | null;
  /** What waits for the resolve key (`PendingPrompts.summary`), shown until it is resolved. */
  getAttention?: () => string | null;
}

export class ModeBar implements Component {
  private recoveryFailed = false;
  setRecoveryFailed(failed: boolean): boolean { const changed = failed !== this.recoveryFailed; this.recoveryFailed = failed; return changed; }
  private notice: { text: string; tone: 'error' | 'info' } | null = null;
  setNotice(text: string | null, tone: 'error' | 'info' = 'error'): void { this.notice = text === null ? null : { text, tone }; }
  getNotice(): string | null { return this.notice?.text ?? null; }
  /** An informational notice lasts until the next key; an error stays until replaced. Returns whether one was cleared. */
  clearInfo(): boolean {
    if (this.notice?.tone !== 'info') return false;
    this.notice = null;
    return true;
  }
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
    if (this.recoveryFailed) return [truncateToWidth(chalk.hex(palette.error)('Recovery checkpoint failed. Save your files before closing.'), width)];
    if (this.notice) return [truncateToWidth(chalk.hex(this.notice.tone === 'error' ? palette.error : palette.accent)(displayLine(this.notice.text)), width)];
    const commandLine = layout.editorMode === 'vim' ? this.options.getVimCommandLine?.() ?? null : null;
    if (commandLine !== null) return [truncateToWidth(chalk.hex(palette.fg)(`:${displayLine(commandLine)}`) + chalk.inverse(' '), width)];
    const parts: string[] = [];
    parts.push(chalk.bold.hex(palette.accent)(this.modeBadge(layout.editorMode)));
    parts.push(chalk.hex(palette.dim)(`focus:${layout.focused}`));
    // The cursor position stays near the start: a long notice of what is waiting must not push it off a narrow bar.
    if (active) {
      const cursor = active.buffer.getCursor();
      parts.push(chalk.hex(palette.dim)(`L${cursor.line + 1}:${cursor.col + 1}`));
    }
    const attention = this.options.getAttention?.() ?? null;
    if (attention) parts.push(chalk.bold.hex(palette.warn)(`⚑ ${displayLine(attention)}`));
    if (active) {
      parts.push(chalk.hex(palette.statusFg)(`${displayLine(active.label)}${active.dirty ? ' ●' : ''}`));
      parts.push(chalk.hex(palette.dim)(active.language));
      if (active.agentLocked) parts.push(chalk.hex(palette.warn)('agent-lock'));
    }
    return [truncateToWidth(parts.join('  '), width)];
  }

  private modeBadge(mode: 'modeless' | 'vim'): string {
    if (mode !== 'vim') return 'EDIT';
    return `VIM ${this.options.getVimMode?.() ?? 'NORMAL'}`;
  }
}
