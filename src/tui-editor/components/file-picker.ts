/**
 * File picker overlay for the editor (Ctrl+O).
 *
 * Walks the workspace root once on mount, lets the user fuzzy-filter
 * the result with a small inline filter buffer, and opens the
 * selected file via the supplied callback.
 *
 * Keeps the implementation walking-based (same as FileTree) so we
 * don't depend on `fd` being installed; pi-tui's CombinedAutocomplete
 * already does fd-aware completion when the user types `@` in the
 * composer, which covers the path-from-keyboard case.
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
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { chalk, getPalette, getSelectListTheme } from '@/tui-pi/theme/defaults';

const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.octipus', '.next', '.cache']);
const MAX_DEPTH = 6;
const MAX_RESULTS = 1000;
const PRINTABLE_CHAR = /^[\w\-./]$/;

export interface FilePickerOptions {
  root: string;
  onPick: (absolutePath: string) => void;
  onCancel: () => void;
  /** Override the file list (mainly for tests). Each entry is an absolute path. */
  files?: string[];
}

export class FilePicker implements Component, Focusable {
  focused = false;
  private list: SelectList;
  private filter = '';
  private readonly allItems: SelectItem[];

  constructor(private readonly options: FilePickerOptions) {
    this.allItems = options.files
      ? options.files.map((p) => fileItem(options.root, p))
      : walk(options.root).map((p) => fileItem(options.root, p));
    this.list = this.buildList(this.allItems);
  }

  private buildList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, 12, getSelectListTheme(), {
      maxPrimaryColumnWidth: 40,
    });
    list.onSelect = (item) => this.options.onPick(item.value);
    list.onCancel = () => this.options.onCancel();
    return list;
  }

  private applyFilter(): void {
    // pi-tui's SelectList.setFilter uses prefix-match on `value` (absolute
    // paths in our case) so it never matches what the user types. We do
    // case-insensitive substring matching on `label` (relative path) and
    // rebuild the SelectList with the matching items.
    const q = this.filter.toLowerCase();
    const next = q.length === 0
      ? this.allItems
      : this.allItems.filter((item) => item.label.toLowerCase().includes(q));
    this.list = this.buildList(next);
  }

  invalidate(): void { this.list.invalidate(); }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) { this.options.onCancel(); return; }
    if (matchesKey(data, 'backspace')) {
      if (this.filter.length === 0) { this.options.onCancel(); return; }
      this.filter = this.filter.slice(0, -1);
      this.applyFilter();
      return;
    }
    if (matchesKey(data, 'up') || matchesKey(data, 'down')
        || matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')
        || matchesKey(data, 'home') || matchesKey(data, 'end')
        || matchesKey(data, 'enter')) {
      this.list.handleInput(data);
      return;
    }
    if (data.length === 1 && PRINTABLE_CHAR.test(data)) {
      this.filter += data;
      this.applyFilter();
    }
  }

  render(width: number): string[] {
    const palette = getPalette();
    const border = (text: string) => chalk.hex(palette.border)(text);
    const dim = (text: string) => chalk.hex(palette.dim)(text);
    const accent = (text: string) => chalk.hex(palette.accent)(text);

    const header = accent('Open file');
    const filterLine = `${dim('filter:')} ${this.filter || dim('(type to filter)')}`;
    const listLines = this.list.render(width - 4);

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

  /** Test aid: read the active filter. */
  getFilter(): string { return this.filter; }
}

function fileItem(root: string, absolutePath: string): SelectItem {
  // Normalize to forward slashes for display so the same label renders
  // identically across Windows (\) and POSIX (/). `value` keeps the
  // platform-native absolute path so the open callback works either way.
  const rel = relative(root, absolutePath).replace(/\\/g, '/');
  return {
    value: absolutePath,
    label: rel || absolutePath,
    description: '',
  };
}

function walk(root: string): string[] {
  const out: string[] = [];
  visit(root, 0, out);
  return out;
}

function visit(dir: string, depth: number, out: string[]): void {
  if (out.length >= MAX_RESULTS || depth > MAX_DEPTH) return;
  let names: string[];
  try { names = readdirSync(dir).sort(); } catch { return; }
  for (const name of names) {
    if (SKIP.has(name)) continue;
    if (out.length >= MAX_RESULTS) return;
    const full = join(dir, name);
    let isDir = false;
    try { isDir = statSync(full).isDirectory(); } catch { continue; }
    if (isDir) visit(full, depth + 1, out);
    else out.push(full);
  }
}

function padTo(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return text;
  return text + ' '.repeat(width - w);
}
