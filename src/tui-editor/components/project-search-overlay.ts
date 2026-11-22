/**
 * Search the project (Ctrl+Shift+F / Alt+G, `/search`).
 *
 * Type a query and press Enter to search (`project-search.ts`: ripgrep when
 * installed, a walk of the project index otherwise). Results arrive while
 * the search runs: one row per match, `path:line` and the line with the match
 * highlighted, and below the list a preview of the selected match with the
 * lines around it. Up/Down (PageUp/PageDown) choose a match; Enter on an
 * unchanged query opens the file at the match. Alt+C/R/W toggle case,
 * regular expressions and whole words, as in find.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { type Component, type Focusable, matchesKey, truncateToWidth } from '@/tui-kit';
import { drawBox } from '@/tui-kit/overlay-frame';
import { TextField } from '@/tui-kit/text-field';
import { displayText } from '../editor/columns';
import type { SearchOptions } from '../editor/search';
import { type ProjectHit, type ProjectSearch, type ProjectSearchDone, searchProject, type SearchProjectOptions } from '../project-search';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

export interface ProjectSearchOverlayOptions {
  root: string;
  /** Open `hit.path` with the match selected. */
  onOpen: (hit: ProjectHit) => void;
  onClose: () => void;
  /** Results arrived: redraw. */
  onUpdate: () => void;
  initialQuery?: string;
  /** Override the search (tests). */
  search?: (root: string, query: string, options: SearchProjectOptions, onHits: (hits: ProjectHit[]) => void) => ProjectSearch;
}

/** Rows of the box that are not results: borders, header, query, flags, separators, preview, keys. */
const CHROME_ROWS = 13;
const PREVIEW_CONTEXT = 2;

export class ProjectSearchOverlay implements Component, Focusable {
  focused = false;
  private readonly field: TextField;
  private flags: SearchOptions = { caseSensitive: false, regex: false, wholeWord: false };
  private hits: ProjectHit[] = [];
  private selected = 0;
  private scroll = 0;
  private searched: string | null = null;
  private state: 'idle' | 'searching' | ProjectSearchDone = 'idle';
  private running: ProjectSearch | null = null;
  private maxRows = 30;
  private readonly fileCache = new Map<string, string[] | null>();

  constructor(private readonly options: ProjectSearchOverlayOptions) {
    this.field = new TextField(options.initialQuery ?? '');
    if (options.initialQuery) this.run();
  }

  invalidate(): void {}

  setMaxRows(rows: number): void { if (Number.isFinite(rows)) this.maxRows = rows; }

  private listRows(): number { return Math.max(1, this.maxRows - CHROME_ROWS); }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) { this.close(); return; }
    if (matchesKey(data, 'enter')) {
      if (this.field.value.trim() && this.searchKey() !== this.searched) { this.run(); return; }
      const hit = this.hits[this.selected];
      if (hit) { this.running?.cancel(); this.options.onOpen(hit); }
      return;
    }
    if (matchesKey(data, 'down')) { this.move(1); return; }
    if (matchesKey(data, 'up')) { this.move(-1); return; }
    if (matchesKey(data, 'pageDown')) { this.move(this.listRows()); return; }
    if (matchesKey(data, 'pageUp')) { this.move(-this.listRows()); return; }
    if (matchesKey(data, 'alt+c')) { this.flags.caseSensitive = !this.flags.caseSensitive; return; }
    if (matchesKey(data, 'alt+r')) { this.flags.regex = !this.flags.regex; return; }
    if (matchesKey(data, 'alt+w')) { this.flags.wholeWord = !this.flags.wholeWord; return; }
    this.field.handleInput(data);
  }

  /** What a search is for: the query and the flags. */
  private searchKey(): string {
    return JSON.stringify([this.field.value.trim(), this.flags]);
  }

  private run(): void {
    this.running?.cancel();
    this.hits = [];
    this.selected = 0;
    this.scroll = 0;
    this.searched = this.searchKey();
    this.state = 'searching';
    const search = (this.options.search ?? searchProject)(this.options.root, this.field.value.trim(), { ...this.flags }, (batch) => {
      if (this.running !== search) return;
      this.hits.push(...batch);
      this.options.onUpdate();
    });
    this.running = search;
    search.done.then(
      (done) => { if (this.running === search) { this.state = done; this.options.onUpdate(); } },
      (error: unknown) => { if (this.running === search) { this.state = { source: 'walk', truncated: false, error: error instanceof Error ? error.message : String(error) }; this.options.onUpdate(); } },
    );
  }

  private move(delta: number): void {
    if (!this.hits.length) return;
    this.selected = Math.max(0, Math.min(this.hits.length - 1, this.selected + delta));
    const rows = this.listRows();
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + rows) this.scroll = this.selected - rows + 1;
  }

  private close(): void {
    this.running?.cancel();
    this.options.onClose();
  }

  render(width: number): string[] {
    const palette = getPalette();
    const border = (text: string) => chalk.hex(palette.border)(text);
    const dim = (text: string) => chalk.hex(palette.dim)(text);
    const accent = (text: string) => chalk.hex(palette.accent)(text);
    const warn = (text: string) => chalk.hex(palette.warn)(text);
    const boxWidth = Math.max(20, width);
    const inner = boxWidth - 4;

    const files = new Set(this.hits.map((h) => h.path)).size;
    const status = this.state === 'idle' ? dim('type a query, Enter to search')
      : this.state === 'searching' ? dim(`searching… ${this.hits.length} so far`)
      : this.state.error ? chalk.hex(palette.error)(this.state.error)
      : this.hits.length === 0 ? dim(`no matches${this.state.cancelled ? ' (cancelled)' : ''}`)
      : dim(`${this.hits.length}${this.state.truncated ? '+' : ''} match${this.hits.length === 1 ? '' : 'es'} in ${files} file${files === 1 ? '' : 's'}${this.state.truncated ? ` (the first ${this.hits.length})` : ''} · ${this.state.source === 'rg' ? 'ripgrep' : 'project index'}`);
    const head = `${accent('Search the project')}  ${status}`;
    const queryLine = `${dim('q:')} ${this.field.render(Math.max(1, inner - 3), this.focused, dim('(text)'))}`;
    const flagsLine = [
      this.flags.caseSensitive ? warn('[Aa]') : dim('[aa]'),
      this.flags.regex ? warn('[.*]') : dim('[··]'),
      this.flags.wholeWord ? warn('[w]') : dim('[w]'),
      dim('  Alt+C/R/W toggle'),
    ].join(' ');

    const rows = this.listRows();
    const list = this.hits.slice(this.scroll, this.scroll + rows).map((hit, i) => this.renderHit(hit, this.scroll + i === this.selected, inner));
    while (list.length < Math.min(rows, Math.max(1, this.hits.length))) list.push('');
    const preview = this.preview(inner);
    const help = dim('Enter search / open · ↑↓ PgUp/PgDn choose · Esc close');
    return drawBox([[head, queryLine, flagsLine], list, preview, [help]], boxWidth, border);
  }

  private renderHit(hit: ProjectHit, selected: boolean, inner: number): string {
    const palette = getPalette();
    const where = `${relative(this.options.root, hit.path)}:${hit.line + 1}`;
    const room = Math.max(10, inner - where.length - 2);
    // Keep the match in view on a long line: start a little before it.
    const start = hit.col > room / 2 ? Math.max(0, hit.col - Math.floor(room / 3)) : 0;
    const lead = displayText(hit.text.slice(start, hit.col)).trimStart();
    const match = displayText(hit.text.slice(hit.col, hit.col + hit.length));
    const tail = displayText(hit.text.slice(hit.col + hit.length));
    const line = `${start > 0 ? '…' : ''}${lead}${chalk.bgHex(palette.warn).hex(palette.cursorFg)(match)}${tail}`;
    const row = `${chalk.hex(palette.accent)(displayText(where))}  ${line}`;
    const marker = selected ? chalk.hex(palette.accent)('▸ ') : '  ';
    const text = truncateToWidth(marker + row, inner, '…');
    return selected ? chalk.bgHex(palette.selection)(text) : text;
  }

  /** The selected match with the lines around it. */
  private preview(inner: number): string[] {
    const palette = getPalette();
    const hit = this.hits[this.selected];
    const rows = PREVIEW_CONTEXT * 2 + 1;
    if (!hit) return Array(rows).fill('');
    const lines = this.lines(hit.path);
    const out: string[] = [];
    for (let n = hit.line - PREVIEW_CONTEXT; n <= hit.line + PREVIEW_CONTEXT; n++) {
      const text = n < 0 ? undefined : lines?.[n] ?? (n === hit.line ? hit.text : undefined);
      if (text === undefined) { out.push(''); continue; }
      const number = chalk.hex(palette.dim)(`${String(n + 1).padStart(5)} `);
      if (n !== hit.line) { out.push(number + chalk.hex(palette.dim)(displayText(text))); continue; }
      out.push(number + displayText(text.slice(0, hit.col)) + chalk.bgHex(palette.warn).hex(palette.cursorFg)(displayText(text.slice(hit.col, hit.col + hit.length))) + displayText(text.slice(hit.col + hit.length)));
    }
    return out.map((line) => truncateToWidth(line, inner, '…'));
  }

  private lines(path: string): string[] | null {
    if (!this.fileCache.has(path)) {
      let lines: string[] | null;
      try {
        lines = readFileSync(path, 'utf8').split('\n').map((l) => l.replace(/\r$/, ''));
      } catch {
        // Gone since it was searched: the preview shows the matched line alone.
        lines = null;
      }
      this.fileCache.set(path, lines);
    }
    return this.fileCache.get(path) ?? null;
  }

  // ── Test helpers ───────────────────────────────────────────────
  getHits(): readonly ProjectHit[] { return this.hits; }
  getSelected(): number { return this.selected; }
}
