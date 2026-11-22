/**
 * One fuzzy-filtered list with a preview, for every picker: commands,
 * sessions, models, skills, input history.
 *
 * Typing filters (letters in order, `fuzzyFilter`'s rules: space- or
 * slash-separated words must all match); Up/Down, PageUp/PageDown,
 * Home/End move; Enter chooses; Escape — or Backspace on an empty filter —
 * closes. A click on a row chooses it. The preview below the list shows
 * what the highlighted entry is, from the caller's `preview`.
 *
 * Rows are drawn in a box no wider than given and, through `setMaxRows`,
 * no taller than the overlay may be; the list gives way before the preview,
 * the preview before the filter line.
 */
import { type Component, fuzzyFilter, type Focusable, matchesKey, truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { displayLine, displayText } from './terminal-text';

export interface FuzzyListItem<T> {
  value: T;
  label: string;
  /** Shown dim after the label. */
  description?: string;
  /** What the filter matches against; the label and description by default. */
  search?: string;
}

export interface FuzzyListTheme {
  border: (text: string) => string;
  title: (text: string) => string;
  selected: (text: string) => string;
  dim: (text: string) => string;
}

export interface FuzzyListOptions<T> {
  title: string;
  items: FuzzyListItem<T>[];
  theme: FuzzyListTheme;
  onSelect: (item: FuzzyListItem<T>) => void;
  onCancel: () => void;
  /** What the highlighted item is, in full: wrapped below the list. */
  preview?: (item: FuzzyListItem<T>) => string;
  /** Rows of the list at most. Default 10. */
  maxVisible?: number;
  /** Rows of the preview at most. Default 6. */
  maxPreview?: number;
  /** Shown while there is nothing to list (loading, or none). */
  emptyText?: string;
}

/** Bytes that are keys, not text: control characters and escape sequences. */
const NOT_TEXT = /[\x00-\x1f\x7f]|^\x1b/;

export class FuzzyList<T> implements Component, Focusable {
  focused = false;
  private filter = '';
  private items: FuzzyListItem<T>[];
  private shown: FuzzyListItem<T>[];
  private selected = 0;
  private top = 0;
  private maxRows = Number.POSITIVE_INFINITY;
  private emptyText: string;
  /** Where the list rows were drawn last, for clicks: the first row and how many. */
  private listAt = { row: 0, count: 0 };

  constructor(private readonly options: FuzzyListOptions<T>) {
    this.items = options.items;
    this.shown = this.items;
    this.emptyText = options.emptyText ?? 'Nothing to show';
  }

  /** Replace the items (they arrived), keeping the filter. */
  setItems(items: FuzzyListItem<T>[], emptyText?: string): void {
    this.items = items;
    if (emptyText !== undefined) this.emptyText = emptyText;
    this.refilter();
  }
  getFilter(): string { return this.filter; }
  /** The items the filter leaves, best first. */
  visibleItems(): readonly FuzzyListItem<T>[] { return this.shown; }
  highlighted(): FuzzyListItem<T> | undefined { return this.shown[this.selected]; }
  setMaxRows(rows: number): void { this.maxRows = rows; }

  private refilter(): void {
    this.shown = this.filter.trim()
      ? fuzzyFilter(this.items, this.filter, item => item.search ?? `${item.label} ${item.description ?? ''}`)
      : this.items;
    this.selected = 0;
    this.top = 0;
  }

  private move(by: number): void {
    if (!this.shown.length) return;
    this.selected = Math.max(0, Math.min(this.shown.length - 1, this.selected + by));
  }

  handleInput(data: string): void {
    const page = Math.max(1, this.options.maxVisible ?? 10);
    if (matchesKey(data, 'escape')) { this.options.onCancel(); return; }
    if (matchesKey(data, 'enter')) { const item = this.highlighted(); if (item) this.options.onSelect(item); return; }
    if (matchesKey(data, 'up')) { this.move(-1); return; }
    if (matchesKey(data, 'down')) { this.move(1); return; }
    if (matchesKey(data, 'pageUp')) { this.move(-page); return; }
    if (matchesKey(data, 'pageDown')) { this.move(page); return; }
    if (matchesKey(data, 'home')) { this.move(-this.shown.length); return; }
    if (matchesKey(data, 'end')) { this.move(this.shown.length); return; }
    if (matchesKey(data, 'backspace')) {
      if (!this.filter) { this.options.onCancel(); return; }
      this.filter = [...this.filter].slice(0, -1).join('');
      this.refilter();
      return;
    }
    // Bracketed paste arrives wrapped in its markers: keep the text.
    const text = data.replace(/\x1b\[20[01]~/g, '');
    if (!text || NOT_TEXT.test(text)) return;
    this.filter += text.replace(/\s+/g, ' ');
    this.refilter();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === 'wheel') { this.move(Math.sign(event.wheelDelta ?? 0)); return { handled: true }; }
    const index = event.y - this.listAt.row;
    if (event.button !== 'left' || index < 0 || index >= this.listAt.count) return undefined;
    if (event.type === 'click') {
      this.selected = this.top + index;
      const item = this.highlighted();
      if (item) this.options.onSelect(item);
    }
    return { handled: true };
  }

  invalidate(): void {}

  render(width: number): string[] {
    const t = this.options.theme;
    const boxWidth = Math.max(4, width);
    const inner = boxWidth - 4;
    const row = (text: string) => {
      const cut = truncateToWidth(text, inner, '…');
      return `${t.border('│ ')}${cut}${' '.repeat(Math.max(0, inner - visibleWidth(cut)))}${t.border(' │')}`;
    };
    const rule = (left: string, right: string) => t.border(left + '─'.repeat(boxWidth - 2) + right);

    const count = this.items.length ? ` ${this.shown.length}/${this.items.length}` : '';
    const header = row(`${t.title(displayLine(this.options.title))}${t.dim(count)}`);
    const filterLine = row(`${t.dim('filter:')} ${this.filter ? displayLine(this.filter) : t.dim('(type to filter)')}`);
    const hint = row(t.dim('↑↓ move · Enter choose · Esc close'));
    const item = this.highlighted();
    const previewText = item && this.options.preview ? displayText(this.options.preview(item)) : '';
    const preview = previewText ? previewText.split('\n').flatMap(line => wrapTextWithAnsi(line, inner)) : [];

    // Fixed rows: the borders, header, hint; then the filter line, a list row, the preview, the rest of the list.
    const budget = Math.max(1, this.maxRows) - 4;
    const fixed = Math.max(0, budget);
    const withFilter = fixed >= 2;
    let listRows = Math.min(this.options.maxVisible ?? 10, Math.max(1, this.shown.length));
    let previewRows = Math.min(this.options.maxPreview ?? 6, preview.length);
    const room = fixed - (withFilter ? 1 : 0);
    listRows = Math.max(0, Math.min(listRows, room));
    previewRows = Math.max(0, Math.min(previewRows, room - listRows - 1));
    if (this.selected < this.top) this.top = this.selected;
    if (this.selected >= this.top + listRows) this.top = this.selected - listRows + 1;

    const lines = [rule('┌', '┐'), header];
    if (withFilter) lines.push(filterLine);
    this.listAt = { row: lines.length, count: 0 };
    if (!this.shown.length) {
      if (listRows > 0) lines.push(row(t.dim(this.items.length ? 'No match' : this.emptyText)));
    } else {
      const page = this.shown.slice(this.top, this.top + listRows);
      this.listAt.count = page.length;
      for (const [offset, entry] of page.entries()) {
        const active = this.top + offset === this.selected;
        const label = displayLine(entry.label);
        const description = entry.description ? t.dim(`  ${displayLine(entry.description)}`) : '';
        lines.push(row(active ? `${t.selected(`› ${label}`)}${description}` : `  ${label}${description}`));
      }
    }
    if (previewRows > 0) {
      lines.push(rule('├', '┤'));
      for (const line of preview.slice(0, previewRows)) lines.push(row(line));
    }
    lines.push(hint, rule('└', '┘'));
    return lines;
  }
}
