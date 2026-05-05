/**
 * Command palette overlay (Ctrl+P).
 *
 * Wraps pi-tui's SelectList over OCTIPUS_SLASH_COMMANDS. Selection
 * fires `onCommand` with the command name (no leading `/`) so the
 * caller can route through its existing slash command handler.
 *
 * Filtering is delegated to SelectList via `setFilter`. We watch
 * keystrokes that aren't navigation keys, append/erase from a small
 * filter buffer, and forward to the list. Phase 6 will replace the
 * filter buffer with a proper Input child once the palette grows
 * past command names (e.g. when extensions register commands with
 * arbitrary keywords).
 */
import {
  type Component,
  type Focusable,
  matchesKey,
  type SelectItem,
  SelectList,
  truncateToWidth,
  visibleWidth,
} from '@mariozechner/pi-tui';
import { chalk, getPalette, getSelectListTheme } from '../theme/defaults';
import { OCTIPUS_SLASH_COMMANDS } from '../slash-commands';

export interface CommandPaletteOptions {
  onCommand: (commandName: string) => void;
  onCancel: () => void;
  /** Override the command list (mainly for tests). */
  items?: SelectItem[];
  /** SelectList max visible rows. */
  maxVisible?: number;
}

const PRINTABLE_CHAR = /^[\w\-./?@]$/;

function defaultItems(): SelectItem[] {
  return OCTIPUS_SLASH_COMMANDS.map((cmd) => ({
    value: cmd.name,
    label: `/${cmd.name}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ''}`,
    description: cmd.description ?? '',
  }));
}

export class CommandPalette implements Component, Focusable {
  focused = false;
  private readonly list: SelectList;
  private filter = '';

  constructor(private readonly options: CommandPaletteOptions) {
    const items = options.items ?? defaultItems();
    this.list = new SelectList(items, options.maxVisible ?? 8, getSelectListTheme());
    this.list.onSelect = (item) => this.options.onCommand(item.value);
    this.list.onCancel = () => this.options.onCancel();
  }

  invalidate(): void { this.list.invalidate(); }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) { this.options.onCancel(); return; }

    if (matchesKey(data, 'backspace')) {
      if (this.filter.length === 0) {
        this.options.onCancel();
        return;
      }
      this.filter = this.filter.slice(0, -1);
      this.list.setFilter(this.filter);
      return;
    }

    // Forward navigation + Enter to the list as-is.
    if (matchesKey(data, 'up') || matchesKey(data, 'down')
        || matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')
        || matchesKey(data, 'home') || matchesKey(data, 'end')
        || matchesKey(data, 'enter')) {
      this.list.handleInput(data);
      return;
    }

    // Single printable char (no modifier) → extend filter.
    if (data.length === 1 && PRINTABLE_CHAR.test(data)) {
      this.filter += data;
      this.list.setFilter(this.filter);
    }
  }

  render(width: number): string[] {
    const palette = getPalette();
    const border = (text: string) => chalk.hex(palette.border)(text);
    const dim = (text: string) => chalk.hex(palette.dim)(text);
    const accent = (text: string) => chalk.hex(palette.accent)(text);

    const header = accent('Command palette');
    const filterLine = `${dim('filter:')} ${this.filter || dim('(type to filter)')}`;
    const listLines = this.list.render(width - 2);

    const innerWidth = Math.max(
      visibleWidth(header),
      visibleWidth(filterLine),
      ...listLines.map(visibleWidth),
    );
    const boxWidth = Math.min(width, innerWidth + 4);
    const inner = boxWidth - 4;
    const top    = border('┌' + '─'.repeat(boxWidth - 2) + '┐');
    const middle = (text: string) => border('│ ') + padTo(truncateToWidth(text, inner), inner) + border(' │');
    const bottom = border('└' + '─'.repeat(boxWidth - 2) + '┘');

    return [top, middle(header), middle(filterLine), ...listLines.map((line) => middle(line)), bottom];
  }

  /** Currently active filter string (testing aid). */
  getFilter(): string { return this.filter; }
}

function padTo(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return text;
  return text + ' '.repeat(width - w);
}
