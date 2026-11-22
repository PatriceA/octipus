/**
 * Phase 5 file tree.
 *
 * Walks the workspace root lazily: only expanded directories load their
 * children. Initial render shows the root and its immediate descendants
 * collapsed. Enter toggles a directory; on a file it opens it via the
 * BufferStore. Left collapses the current dir (or jumps to the parent
 * if already collapsed) and Right expands it (or descends if already
 * expanded).
 */
import { type Component, displayLine, type Focusable, matchesKey, truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult } from '@/tui-kit';
import { basename } from 'node:path';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';
import { getGlyphs } from '@/tui-pi/theme/glyphs';
import { listFolder } from '../project-files';
const MAX_ENTRIES = 2000;

interface Entry {
  path: string;
  label: string;
  depth: number;
  isDir: boolean;
  parent?: string;
}

export interface FileTreeOptions {
  root: string;
  onOpen: (absolutePath: string) => void;
  /** The tree was clicked: give it the focus. */
  onFocus?: () => void;
}

export class FileTree implements Component, Focusable {
  focused = false;
  private entries: Entry[] = [];
  private selected = 0;
  private scrollTop = 0;
  private height = 20;
  // Tracks which directories are expanded. The root is always expanded.
  private expanded: Set<string> = new Set();

  constructor(private options: FileTreeOptions) {
    this.expanded.add(options.root);
    this.refresh();
  }

  setHeight(rows: number): void { this.height = Math.max(1, rows); }

  /** Re-walk the filesystem honoring current expanded set. */
  refresh(): void {
    this.entries = walk(this.options.root, this.expanded);
    if (this.selected >= this.entries.length) this.selected = Math.max(0, this.entries.length - 1);
  }

  invalidate(): void { /* re-read happens via explicit refresh() */ }

  handleInput(data: string): void {
    if (matchesKey(data, 'up'))    { this.move(-1); return; }
    if (matchesKey(data, 'down'))  { this.move( 1); return; }
    if (matchesKey(data, 'pageUp'))   { this.move(-this.height); return; }
    if (matchesKey(data, 'pageDown')) { this.move( this.height); return; }
    if (matchesKey(data, 'home'))  { this.selected = 0; this.scrollIntoView(); return; }
    if (matchesKey(data, 'end'))   { this.selected = Math.max(0, this.entries.length - 1); this.scrollIntoView(); return; }
    if (matchesKey(data, 'enter')) {
      const entry = this.entries[this.selected];
      if (!entry) return;
      if (entry.isDir) this.toggle(entry);
      else this.options.onOpen(entry.path);
      return;
    }
    if (matchesKey(data, 'right')) {
      const entry = this.entries[this.selected];
      if (!entry || !entry.isDir) return;
      if (!this.expanded.has(entry.path)) {
        this.expanded.add(entry.path);
        this.refresh();
      } else {
        // Already expanded — descend to first child.
        this.move(1);
      }
      return;
    }
    if (matchesKey(data, 'left')) {
      const entry = this.entries[this.selected];
      if (!entry) return;
      if (entry.isDir && this.expanded.has(entry.path)) {
        this.expanded.delete(entry.path);
        this.refresh();
        return;
      }
      // Jump to parent
      if (entry.parent) {
        const parentIdx = this.entries.findIndex((e) => e.path === entry.parent);
        if (parentIdx >= 0) { this.selected = parentIdx; this.scrollIntoView(); }
      }
      return;
    }
    if (matchesKey(data, 'r') && this.focused) { this.refresh(); }
  }

  /**
   * The mouse: a click on a row selects it and opens the file or expands
   * (collapses) the folder; the wheel scrolls without moving the selection.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === 'wheel') { if (event.wheelDelta) this.scrollBy(event.wheelDelta); return { handled: true }; }
    if (event.type === 'press' && event.button === 'left') { this.options.onFocus?.(); return { handled: true }; }
    if (event.type !== 'click' || event.button !== 'left') return { handled: true };
    const index = this.scrollTop + event.y;
    const entry = this.entries[index];
    if (!entry) return { handled: true };
    this.selected = index;
    if (entry.isDir) this.toggle(entry);
    else this.options.onOpen(entry.path);
    return { handled: true };
  }

  /** Scroll the rows shown by `delta`, leaving the selection where it is. */
  scrollBy(delta: number): void {
    this.scrollTop = Math.max(0, Math.min(Math.max(0, this.entries.length - this.height), this.scrollTop + delta));
  }

  /** Paths of the folders shown expanded (tests, and keeping them open across a refresh). */
  isExpanded(path: string): boolean { return this.expanded.has(path); }

  render(width: number): string[] {
    const palette = getPalette();
    const lines: string[] = [];
    const end = Math.min(this.entries.length, this.scrollTop + this.height);
    for (let i = this.scrollTop; i < end; i++) {
      const entry = this.entries[i];
      const indent = '  '.repeat(entry.depth);
      const glyphs = getGlyphs();
      // Show ▾ for expanded dirs, ▸ for collapsed, file glyph for files.
      const dirMarker = entry.isDir ? (this.expanded.has(entry.path) ? '▾ ' : '▸ ') : '';
      const icon = entry.isDir ? glyphs.dir : glyphs.file;
      const text = `${indent}${dirMarker}${icon}${displayLine(entry.label)}`;
      const styled = entry.isDir ? chalk.hex(palette.accent)(text) : chalk.hex(palette.fg)(text);
      const isSelected = this.focused && i === this.selected;
      const line = isSelected ? chalk.bgHex(palette.selection)(styled) : styled;
      lines.push(truncateToWidth(line, width));
    }
    while (lines.length < this.height) lines.push('');
    return lines;
  }

  private move(delta: number): void {
    if (this.entries.length === 0) return;
    this.selected = Math.min(this.entries.length - 1, Math.max(0, this.selected + delta));
    this.scrollIntoView();
  }

  private toggle(entry: Entry): void {
    if (this.expanded.has(entry.path)) this.expanded.delete(entry.path);
    else this.expanded.add(entry.path);
    this.refresh();
  }

  private scrollIntoView(): void {
    if (this.selected < this.scrollTop) this.scrollTop = this.selected;
    else if (this.selected >= this.scrollTop + this.height) this.scrollTop = this.selected - this.height + 1;
  }
}

function walk(root: string, expanded: Set<string>): Entry[] {
  const out: Entry[] = [];
  out.push({ path: root, label: basename(root) || root, depth: 0, isDir: true });
  visit(root, 1, out, expanded);
  return out;
}

function visit(dir: string, depth: number, out: Entry[], expanded: Set<string>): void {
  for (const entry of listFolder(dir)) {
    if (out.length >= MAX_ENTRIES) return;
    out.push({ path: entry.path, label: entry.name, depth, isDir: entry.isDir, parent: dir });
    // Lazy expansion — only descend into directories the user has opened.
    if (entry.isDir && expanded.has(entry.path)) visit(entry.path, depth + 1, out, expanded);
  }
}
