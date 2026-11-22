/**
 * Find overlay (Ctrl+F).
 *
 * Live, incremental search against the active buffer via
 * `editor/search.ts`. Renders the query, the match counter
 * (`3 / 17`) and the flags; the matches themselves are drawn in the
 * buffer (`onMatches`), the current one distinct from the rest.
 *
 * The search starts from the cursor: the first match shown is the first
 * one at or after where the cursor was when the box opened.
 *
 * Keys:
 *   Enter       — next match
 *   Shift+Enter — previous match
 *   Alt+Enter   — close, with the cursor on the current match
 *   Esc         — close, cursor back where it was before the search
 *                 (so does Backspace on an empty query)
 *   Alt+C       — toggle case-sensitive
 *   Alt+R       — toggle regex mode
 *   Alt+W       — toggle whole-word
 *
 * The query is a `TextField`: paste, emoji and IME input work.
 */
import {
  type Component,
  type Focusable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from '@/tui-kit';
import { type Position, positionLte } from '../editor/buffer';
import { findAll, InvalidPatternError, type Match, type SearchOptions } from '../editor/search';
import type { BufferStore } from '../stores/buffer-store';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';
import { TextField } from './text-field';

export interface FindOverlayOptions {
  buffers: BufferStore;
  onClose: () => void;
  /** The matches to draw in the buffer and the current one; `null` when the box closes. */
  onMatches?: (bufferId: string | null, matches: readonly Match[], current: Match | null) => void;
}

export class FindOverlay implements Component, Focusable {
  focused = false;
  private readonly field = new TextField();
  private flags: SearchOptions = { caseSensitive: false, regex: false, wholeWord: false };
  private matches: Match[] = [];
  private index = 0;
  private error = '';
  /** Where the cursor and selection were when the box opened: the search starts here and Esc returns here. */
  private readonly origin: { bufferId: string; cursor: Position; selection: [Position, Position] | null } | null;

  constructor(private readonly options: FindOverlayOptions) {
    const active = options.buffers.active();
    this.origin = active ? { bufferId: active.id, cursor: active.buffer.getCursor(), selection: active.buffer.selectionRange() } : null;
  }

  invalidate(): void { /* recomputed on input */ }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || (matchesKey(data, 'backspace') && this.field.value === '')) { this.restore(); this.close(); return; }
    if (matchesKey(data, 'alt+enter'))   { this.close(); return; }
    if (matchesKey(data, 'shift+enter')) { this.cycle(-1); return; }
    if (matchesKey(data, 'enter'))       { this.cycle(1); return; }
    if (matchesKey(data, 'alt+c'))       { this.flags.caseSensitive = !this.flags.caseSensitive; this.recompute(); return; }
    if (matchesKey(data, 'alt+r'))       { this.flags.regex          = !this.flags.regex;          this.recompute(); return; }
    if (matchesKey(data, 'alt+w'))       { this.flags.wholeWord      = !this.flags.wholeWord;      this.recompute(); return; }
    if (this.field.handleInput(data)) this.recompute();
  }

  render(width: number): string[] {
    const palette = getPalette();
    const border = (text: string) => chalk.hex(palette.border)(text);
    const dim = (text: string) => chalk.hex(palette.dim)(text);
    const accent = (text: string) => chalk.hex(palette.accent)(text);
    const warn = (text: string) => chalk.hex(palette.warn)(text);

    const count = this.matches.length > 0 ? ` ${this.index + 1} / ${this.matches.length}` : this.field.value ? ' · no matches' : '';
    const head = accent(`Find${count}`);
    const boxWidth = Math.min(width, 64);
    const inner = Math.max(1, boxWidth - 4);
    const queryLine = `${dim('q:')} ${this.field.render(Math.max(1, inner - 3), this.focused, dim('(type to search)'))}`;
    const flagsLine = [
      this.flags.caseSensitive ? warn('[Aa]') : dim('[aa]'),
      this.flags.regex         ? warn('[.*]') : dim('[··]'),
      this.flags.wholeWord     ? warn('[w]')  : dim('[w]'),
      dim('  Alt+C/R/W toggle'),
    ].join(' ');
    const help = dim('Enter next · Shift+Enter prev · Alt+Enter stay · Esc back');

    const lines = [head, queryLine, ...(this.error ? [chalk.hex(palette.error)(this.error)] : []), flagsLine, help];
    const top    = border('┌' + '─'.repeat(Math.max(0, boxWidth - 2)) + '┐');
    const middle = (text: string) => border('│ ') + padTo(truncateToWidth(text, inner), inner) + border(' │');
    const bottom = border('└' + '─'.repeat(Math.max(0, boxWidth - 2)) + '┘');
    return [top, ...lines.map(middle), bottom];
  }

  // ── Helpers ────────────────────────────────────────────────────

  private recompute(): void {
    const active = this.options.buffers.active();
    this.error = '';
    try {
      this.matches = active ? findAll(active.buffer, this.field.value, this.flags) : [];
    } catch (error) {
      if (!(error instanceof InvalidPatternError)) throw error;
      this.matches = [];
      this.error = `Invalid regex: ${error.message}`;
    }
    // The first match at or after where the search started.
    const from = this.origin?.cursor ?? { line: 0, col: 0 };
    const at = this.matches.findIndex((m) => positionLte(from, { line: m.line, col: m.col }));
    this.index = at === -1 ? 0 : at;
    if (this.matches.length === 0) this.restore();
    this.applyCursor();
  }

  private cycle(direction: 1 | -1): void {
    if (this.matches.length === 0) return;
    this.index = (this.index + direction + this.matches.length) % this.matches.length;
    this.applyCursor();
  }

  private applyCursor(): void {
    const active = this.options.buffers.active();
    const m = this.matches[this.index];
    if (active && m) {
      // The match is selected with the cursor at its start, so closing with Alt+Enter leaves it ready to type over.
      active.buffer.select({ line: m.line, col: m.col + m.length }, { line: m.line, col: m.col });
    }
    this.options.onMatches?.(active?.id ?? null, this.matches, m ?? null);
  }

  /** Put the cursor and selection back where they were before the search. */
  private restore(): void {
    const active = this.options.buffers.active();
    if (!active || !this.origin || active.id !== this.origin.bufferId) return;
    if (this.origin.selection) active.buffer.select(this.origin.selection[0], this.origin.selection[1]);
    else active.buffer.setCursor(this.origin.cursor);
  }

  private close(): void {
    this.options.onMatches?.(null, [], null);
    this.options.onClose();
  }

  // ── Test helpers ───────────────────────────────────────────────

  getQuery():   string         { return this.field.value; }
  getFlags():   SearchOptions  { return { ...this.flags }; }
  getMatches(): readonly Match[] { return this.matches; }
  getIndex():   number         { return this.index; }
}

function padTo(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return text;
  return text + ' '.repeat(width - w);
}
