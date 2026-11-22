/**
 * File picker overlay for the editor (Ctrl+O).
 *
 * Indexes the project asynchronously on open (`project-files.ts`: `git
 * ls-files` in a git work tree, so `.gitignore` is respected, a walk
 * otherwise) and ranks the whole index against the filter with a fuzzy
 * match — `hdr` finds `src/components/header.ts` however many files sort
 * before it. The list shows the best `LIST_LIMIT` matches. Typing a name
 * and Enter before the index has arrived opens the best match when it does.
 *
 * The filter is a `TextField`: paste, emoji and IME input work.
 */
import {
  type Component,
  displayLine,
  type Focusable,
  matchesKey,
  type SelectItem,
  SelectList,
} from '@/tui-kit';
import { drawBox, fitBoxWidth } from '@/tui-kit/overlay-frame';
import { fuzzyMatch } from '@/tui-kit/editing';
import { relative } from 'node:path';
import { chalk, getPalette, getSelectListTheme } from '@/tui-pi/theme/defaults';
import { indexProjectFiles, type ProjectIndex } from '../project-files';
import { TextField } from '@/tui-kit/text-field';

/** Rows of matches handed to the list; the rest are counted, not shown. */
export const LIST_LIMIT = 500;

export interface FilePickerOptions {
  root: string;
  onPick: (absolutePath: string) => void;
  onCancel: () => void;
  /** Called when the index arrives, so the app can redraw. */
  onUpdate?: () => void;
  /** A ready file list (tests); otherwise the project is indexed. Absolute paths. */
  files?: string[];
  /** The index to wait for; defaults to `indexProjectFiles(root)`. */
  index?: Promise<ProjectIndex>;
}

export class FilePicker implements Component, Focusable {
  focused = false;
  private list: SelectList;
  private readonly field = new TextField();
  private allItems: SelectItem[] = [];
  private visible: SelectItem[] = [];
  private shown = 0;
  private matched = 0;
  private state: 'indexing' | 'ready' | 'failed' = 'indexing';
  /** Enter pressed before the index arrived: open the best match as soon as it does. */
  private pickWhenReady = false;
  private note = '';

  constructor(private readonly options: FilePickerOptions) {
    this.list = this.buildList([]);
    if (options.files) {
      this.setFiles({ files: options.files, source: 'walk', truncated: false });
    } else {
      (options.index ?? indexProjectFiles(options.root)).then(
        (index) => { this.setFiles(index); options.onUpdate?.(); },
        (error: unknown) => {
          this.state = 'failed';
          this.note = `Could not list the project's files: ${error instanceof Error ? error.message : String(error)}`;
          options.onUpdate?.();
        },
      );
    }
  }

  private setFiles(index: ProjectIndex): void {
    this.allItems = index.files.map((p) => fileItem(this.options.root, p));
    this.state = 'ready';
    this.note = index.truncated ? `Indexed the first ${index.files.length.toLocaleString('en-US')} files.` : '';
    this.applyFilter();
    const best = this.visible[0];
    if (this.pickWhenReady && best && this.field.value.trim()) this.options.onPick(best.value);
    this.pickWhenReady = false;
  }

  private buildList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, 12, getSelectListTheme(), {
      maxPrimaryColumnWidth: 60,
    });
    list.onSelect = (item) => this.options.onPick(item.value);
    list.onCancel = () => this.options.onCancel();
    return list;
  }

  private applyFilter(): void {
    // pi-tui's SelectList.setFilter prefix-matches `value` (absolute paths),
    // which never matches what the user types; rank the labels instead.
    const q = this.field.value.trim();
    let ranked: SelectItem[];
    if (q.length === 0) {
      ranked = this.allItems;
    } else {
      const scored: Array<{ item: SelectItem; score: number }> = [];
      for (const item of this.allItems) {
        const m = fuzzyMatch(q, item.label);
        if (m.matches) scored.push({ item, score: m.score });
      }
      scored.sort((a, b) => a.score - b.score || a.item.label.length - b.item.label.length || a.item.label.localeCompare(b.item.label));
      ranked = scored.map((s) => s.item);
    }
    this.matched = ranked.length;
    const visible = ranked.slice(0, LIST_LIMIT);
    this.shown = visible.length;
    this.visible = visible;
    this.list = this.buildList(visible);
  }

  invalidate(): void { this.list.invalidate(); }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) { this.options.onCancel(); return; }
    if (matchesKey(data, 'backspace') && this.field.value === '') { this.options.onCancel(); return; }
    if (matchesKey(data, 'enter') && this.state === 'indexing') { this.pickWhenReady = true; return; }
    if (matchesKey(data, 'up') || matchesKey(data, 'down')
        || matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')
        || matchesKey(data, 'enter')) {
      this.list.handleInput(data);
      return;
    }
    if (this.field.handleInput(data) && this.state === 'ready') this.applyFilter();
  }

  render(width: number): string[] {
    const palette = getPalette();
    const border = (text: string) => chalk.hex(palette.border)(text);
    const dim = (text: string) => chalk.hex(palette.dim)(text);
    const accent = (text: string) => chalk.hex(palette.accent)(text);

    const header = accent('Open file');
    const filterLine = `${dim('filter:')} ${this.field.render(Math.max(1, width - 12), this.focused, dim('(type to filter)'))}`;
    const status = this.state === 'indexing' ? [dim('Indexing files…')]
      : this.state === 'failed' ? [chalk.hex(palette.error)(this.note)]
      : this.matched === 0 ? [dim(this.allItems.length === 0 ? 'No files in this project.' : 'No file matches.')]
      : [];
    const counts = this.state === 'ready' && this.matched > this.shown
      ? [dim(`${this.shown} of ${this.matched.toLocaleString('en-US')} shown — type to narrow`)]
      : [];
    const notes = this.state === 'ready' && this.note ? [dim(this.note)] : [];
    const listLines = this.state === 'ready' && this.matched > 0 ? this.list.render(width - 4) : [];

    const body = [header, filterLine, ...status, ...listLines, ...counts, ...notes];
    return drawBox([body], fitBoxWidth(body, width), border);
  }

  /** Test aid: read the active filter. */
  getFilter(): string { return this.field.value; }
  /** Test aid: the labels in the list, best first. */
  getShownLabels(): string[] { return this.visible.map((i) => i.label); }
}

function fileItem(root: string, absolutePath: string): SelectItem {
  // Normalize to forward slashes for display so the same label renders
  // identically across Windows (\) and POSIX (/). `value` keeps the
  // platform-native absolute path so the open callback works either way.
  const rel = relative(root, absolutePath).replace(/\\/g, '/');
  return {
    value: absolutePath,
    label: displayLine(rel || absolutePath),
    description: '',
  };
}
