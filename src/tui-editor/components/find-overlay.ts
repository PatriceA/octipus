/**
 * Find overlay (Ctrl+F).
 *
 * Live, incremental search against the active buffer via
 * `editor/search.ts`. Renders the query, the match counter
 * (`3 / 17`), and the current/preview line.
 *
 * Keys:
 *   Enter      — jump to next match
 *   Shift+Enter — previous match
 *   Esc        — close, leave cursor at last visited match
 *   Backspace  — shrink query (close on empty)
 *   Alt+C      — toggle case-sensitive
 *   Alt+R      — toggle regex mode
 *   Alt+W      — toggle whole-word
 *
 * The flag toggles fix the Phase 1 / Phase 5 gap noted in the
 * inventory: search.ts has supported these flags from day one but
 * the old Ink overlay never exposed them.
 */
import {
  type Component,
  type Focusable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from '@mariozechner/pi-tui';
import { findAll, type Match, type SearchOptions } from '../editor/search';
import type { BufferStore } from '../stores/buffer-store';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

const PRINTABLE = /^[^\x00-\x1f\x7f]$/u;

export interface FindOverlayOptions {
  buffers: BufferStore;
  onClose: () => void;
}

export class FindOverlay implements Component, Focusable {
  focused = false;
  private query = '';
  private flags: SearchOptions = { caseSensitive: false, regex: false, wholeWord: false };
  private matches: Match[] = [];
  private index = 0;

  constructor(private readonly options: FindOverlayOptions) {}

  invalidate(): void { /* recomputed each render via search */ }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape'))   { this.options.onClose(); return; }
    if (matchesKey(data, 'backspace')) {
      if (this.query.length === 0) { this.options.onClose(); return; }
      this.query = this.query.slice(0, -1);
      this.recompute(/* resetIndex */ true);
      return;
    }
    if (matchesKey(data, 'enter'))      { this.cycle(1); return; }
    if (matchesKey(data, 'shift+enter')) { this.cycle(-1); return; }
    if (matchesKey(data, 'alt+c'))      { this.flags.caseSensitive = !this.flags.caseSensitive; this.recompute(true); return; }
    if (matchesKey(data, 'alt+r'))      { this.flags.regex          = !this.flags.regex;          this.recompute(true); return; }
    if (matchesKey(data, 'alt+w'))      { this.flags.wholeWord      = !this.flags.wholeWord;      this.recompute(true); return; }
    if (data.length === 1 && PRINTABLE.test(data)) {
      this.query += data;
      this.recompute(true);
    }
  }

  render(width: number): string[] {
    const palette = getPalette();
    const border = (text: string) => chalk.hex(palette.border)(text);
    const dim = (text: string) => chalk.hex(palette.dim)(text);
    const accent = (text: string) => chalk.hex(palette.accent)(text);
    const warn = (text: string) => chalk.hex(palette.warn)(text);

    const head = accent(`Find${this.matches.length > 0 ? ` ${this.index + 1} / ${this.matches.length}` : ''}`);
    const queryLine = `${dim('q:')} ${this.query || dim('(type to search)')}`;
    const flagsLine = [
      this.flags.caseSensitive ? warn('[Aa]') : dim('[aa]'),
      this.flags.regex         ? warn('[.*]') : dim('[··]'),
      this.flags.wholeWord     ? warn('[w]')  : dim('[w]'),
      dim('  Alt+C/R/W toggle'),
    ].join(' ');
    const help = dim('Enter next · Shift+Enter prev · Esc close');

    const lines = [head, queryLine, flagsLine, help];
    const innerWidth = Math.max(...lines.map(visibleWidth));
    const boxWidth = Math.min(width, innerWidth + 4);
    const inner = boxWidth - 4;
    const top    = border('┌' + '─'.repeat(boxWidth - 2) + '┐');
    const middle = (text: string) => border('│ ') + padTo(truncateToWidth(text, inner), inner) + border(' │');
    const bottom = border('└' + '─'.repeat(boxWidth - 2) + '┘');
    return [top, ...lines.map(middle), bottom];
  }

  // ── Helpers ────────────────────────────────────────────────────

  private recompute(resetIndex: boolean): void {
    const active = this.options.buffers.active();
    this.matches = active ? findAll(active.buffer, this.query, this.flags) : [];
    if (resetIndex) this.index = 0;
    this.applyCursor();
  }

  private cycle(direction: 1 | -1): void {
    if (this.matches.length === 0) return;
    this.index = (this.index + direction + this.matches.length) % this.matches.length;
    this.applyCursor();
  }

  private applyCursor(): void {
    if (this.matches.length === 0) return;
    const active = this.options.buffers.active();
    if (!active) return;
    const m = this.matches[this.index];
    active.buffer.setCursor({ line: m.line, col: m.col });
  }

  // ── Test helpers ───────────────────────────────────────────────

  getQuery():   string         { return this.query; }
  getFlags():   SearchOptions  { return { ...this.flags }; }
  getMatches(): readonly Match[] { return this.matches; }
  getIndex():   number         { return this.index; }
}

function padTo(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return text;
  return text + ' '.repeat(width - w);
}
