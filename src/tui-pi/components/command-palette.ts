/**
 * Command palette overlay (Ctrl+P): the command picker.
 *
 * The shared fuzzy list (`@/tui-kit/fuzzy-list`) over OCTIPUS_SLASH_COMMANDS,
 * with each command's description, argument hint and where it runs as the
 * preview. Selection fires `onCommand` with the command name (no leading
 * `/`) so the caller routes it through its existing slash command handler.
 */
import type { Component, Focusable, SelectItem, TuiMouseEvent, TuiMouseEventResult } from '@/tui-kit';
import { FuzzyList, type FuzzyListItem } from '@/tui-kit/fuzzy-list';
import { getFuzzyListTheme } from '../theme/defaults';
import { OCTIPUS_SLASH_COMMANDS } from '../slash-commands';

export interface CommandPaletteOptions {
  onCommand: (commandName: string) => void;
  onCancel: () => void;
  /** Override the command list (mainly for tests). */
  items?: SelectItem[];
  /** Rows of the list at most. */
  maxVisible?: number;
}

function defaultItems(): SelectItem[] {
  return OCTIPUS_SLASH_COMMANDS.map((cmd) => ({
    value: cmd.name,
    label: `/${cmd.name}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ''}`,
    description: cmd.description ?? '',
  }));
}

function preview(item: FuzzyListItem<string>): string {
  const command = OCTIPUS_SLASH_COMMANDS.find(cmd => cmd.name === item.value);
  if (!command) return item.description ?? '';
  const aliases = command.aliases?.length ? `\nAliases: ${command.aliases.map(alias => `/${alias}`).join(', ')}` : '';
  const where = command.source === 'tui' ? 'Runs in this terminal.' : 'Runs on the server.';
  return `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''}\n${command.description ?? ''}${aliases}\n${where}`;
}

export class CommandPalette implements Component, Focusable {
  private readonly list: FuzzyList<string>;

  constructor(options: CommandPaletteOptions) {
    const items = (options.items ?? defaultItems()).map(item => ({ value: item.value, label: item.label, description: item.description, search: `${item.label} ${item.description ?? ''}` }));
    this.list = new FuzzyList<string>({
      title: 'Commands',
      items,
      theme: getFuzzyListTheme(),
      maxVisible: options.maxVisible ?? 8,
      preview,
      onSelect: item => options.onCommand(item.value),
      onCancel: options.onCancel,
    });
  }

  get focused(): boolean { return this.list.focused; }
  set focused(value: boolean) { this.list.focused = value; }
  invalidate(): void { this.list.invalidate(); }
  handleInput(data: string): void { this.list.handleInput(data); }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.list.handleMouse(event); }
  setMaxRows(rows: number): void { this.list.setMaxRows(rows); }
  render(width: number): string[] { return this.list.render(width); }

  /** Currently active filter string (testing aid). */
  getFilter(): string { return this.list.getFilter(); }
}
