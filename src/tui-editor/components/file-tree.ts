/**
 * Phase 5 file tree.
 *
 * Walks the workspace root to a fixed depth and renders directories
 * + files as a flat list with indentation. The user navigates with
 * up/down + Enter to either expand a directory or open a file via
 * the BufferStore.
 *
 * Trades richness for predictability: no lazy expand state, no
 * watch-mode, no fuzzy search. Phase 5.x can layer those on once we
 * see how heavy the cwd scan gets in real workspaces.
 */
import { type Component, type Focusable, matchesKey, truncateToWidth } from '@mariozechner/pi-tui';
import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';
import { getGlyphs } from '@/tui-pi/theme/glyphs';

const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.octipus', '.next', '.cache']);
const MAX_DEPTH = 4;
const MAX_ENTRIES = 400;

interface Entry {
  path: string;
  label: string;
  depth: number;
  isDir: boolean;
}

export interface FileTreeOptions {
  root: string;
  onOpen: (absolutePath: string) => void;
}

export class FileTree implements Component, Focusable {
  focused = false;
  private entries: Entry[] = [];
  private selected = 0;
  private scrollTop = 0;
  private height = 20;

  constructor(private options: FileTreeOptions) {
    this.refresh();
  }

  setHeight(rows: number): void { this.height = Math.max(1, rows); }

  /** Re-walk the filesystem (call after big external changes). */
  refresh(): void {
    this.entries = walk(this.options.root);
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
      if (entry && !entry.isDir) this.options.onOpen(entry.path);
      return;
    }
    if (matchesKey(data, 'r') && this.focused) { this.refresh(); }
  }

  render(width: number): string[] {
    const palette = getPalette();
    const lines: string[] = [];
    const end = Math.min(this.entries.length, this.scrollTop + this.height);
    for (let i = this.scrollTop; i < end; i++) {
      const entry = this.entries[i];
      const indent = '  '.repeat(entry.depth);
      const glyphs = getGlyphs();
      const icon = entry.isDir ? glyphs.dir : glyphs.file;
      const text = `${indent}${icon}${entry.label}`;
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

  private scrollIntoView(): void {
    if (this.selected < this.scrollTop) this.scrollTop = this.selected;
    else if (this.selected >= this.scrollTop + this.height) this.scrollTop = this.selected - this.height + 1;
  }
}

function walk(root: string): Entry[] {
  const out: Entry[] = [];
  out.push({ path: root, label: basename(root) || root, depth: 0, isDir: true });
  visit(root, 1, out);
  return out;
}

function visit(dir: string, depth: number, out: Entry[]): void {
  if (out.length >= MAX_ENTRIES) return;
  if (depth > MAX_DEPTH) return;
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch { return; }
  for (const name of names) {
    if (SKIP.has(name)) continue;
    if (out.length >= MAX_ENTRIES) return;
    const full = join(dir, name);
    let isDir = false;
    try { isDir = statSync(full).isDirectory(); } catch { continue; }
    out.push({ path: full, label: basename(full), depth, isDir });
    if (isDir) visit(full, depth + 1, out);
  }
}
