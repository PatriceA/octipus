/**
 * Replace overlay (Alt+R).
 *
 * Two fields (find / replace) navigated with Tab. The matches are drawn in
 * the buffer (`onMatches`) and the current one is selected, starting from
 * the cursor; the box previews what the current match becomes.
 *
 *   Alt+Enter — replace the current match (one undo step) and go to the next
 *   ↑ / ↓     — previous / next match, without replacing
 *   Enter     — replace every match, as one undo step, and close
 *   Esc       — close (reporting how many were replaced one at a time)
 *
 * Same flag toggles as FindOverlay (Alt+C/R/W). In regex mode the
 * replacement expands `$1`, `$<name>`, `$&` and `$$`, and the preview shows
 * the expansion for the current match.
 *
 * Both fields are `TextField`s: paste, emoji and IME input work.
 */
import { type Component, type Focusable, matchesKey } from '@/tui-kit';
import { drawBox } from '@/tui-kit/overlay-frame';
import { TextField } from '@/tui-kit/text-field';
import { type Position, positionLte } from '../editor/buffer';
import { displayText } from '../editor/columns';
import { findAll, InvalidPatternError, type Match, replaceAll, replaceOne, replacementFor, type SearchOptions } from '../editor/search';
import type { BufferStore } from '../stores/buffer-store';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

type Field = 'find' | 'replace';

export interface ReplaceOverlayOptions {
  buffers: BufferStore;
  /** Replacing is done: `count` matches were replaced. Closes the box. */
  onCommit: (count: number) => void;
  onClose: () => void;
  /** The matches to draw in the buffer and the current one; `null` when the box closes. */
  onMatches?: (bufferId: string | null, matches: readonly Match[], current: Match | null) => void;
}

export class ReplaceOverlay implements Component, Focusable {
  focused = false;
  private active: Field = 'find';
  private readonly find = new TextField();
  private readonly replace = new TextField();
  private flags: SearchOptions = { caseSensitive: false, regex: false, wholeWord: false };
  private matches: Match[] = [];
  private index = 0;
  private error = '';
  /** Matches replaced one at a time so far. */
  private replaced = 0;
  /** Where the search continues from: the cursor when the box opened, then after each replacement. */
  private from: Position;

  constructor(private readonly options: ReplaceOverlayOptions) {
    this.from = options.buffers.active()?.buffer.getCursor() ?? { line: 0, col: 0 };
  }

  invalidate(): void { /* recomputed on input */ }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) { this.close(); return; }
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      this.active = this.active === 'find' ? 'replace' : 'find'; return;
    }
    if (matchesKey(data, 'alt+enter')) { this.replaceCurrent(); return; }
    if (matchesKey(data, 'enter')) { this.commit(); return; }
    if (matchesKey(data, 'down')) { this.cycle(1); return; }
    if (matchesKey(data, 'up')) { this.cycle(-1); return; }
    if (matchesKey(data, 'backspace') && this.active === 'find' && this.find.value === '') { this.close(); return; }
    if (matchesKey(data, 'alt+c')) { this.flags.caseSensitive = !this.flags.caseSensitive; this.recompute(); return; }
    if (matchesKey(data, 'alt+r')) { this.flags.regex          = !this.flags.regex;          this.recompute(); return; }
    if (matchesKey(data, 'alt+w')) { this.flags.wholeWord      = !this.flags.wholeWord;      this.recompute(); return; }
    const field = this.active === 'find' ? this.find : this.replace;
    if (field.handleInput(data) && this.active === 'find') this.recompute();
  }

  render(width: number): string[] {
    const palette = getPalette();
    const border = (text: string) => chalk.hex(palette.border)(text);
    const dim = (text: string) => chalk.hex(palette.dim)(text);
    const accent = (text: string) => chalk.hex(palette.accent)(text);
    const warn = (text: string) => chalk.hex(palette.warn)(text);

    const count = this.matches.length;
    const boxWidth = Math.min(width, 64);
    const inner = Math.max(1, boxWidth - 4);
    const head = accent(`Replace${count > 0 ? ` ${this.index + 1} / ${count}` : this.find.value ? ' · no matches' : ''}${this.replaced ? ` · ${this.replaced} replaced` : ''}`);
    const findLabel = this.active === 'find'    ? accent('find:')    : dim('find:');
    const repLabel  = this.active === 'replace' ? accent('replace:') : dim('replace:');
    const findLine    = `${findLabel} ${this.find.render(Math.max(1, inner - 6), this.focused && this.active === 'find', dim('(text)'))}`;
    const replaceLine = `${repLabel} ${this.replace.render(Math.max(1, inner - 9), this.focused && this.active === 'replace', dim(this.flags.regex ? '(text, $1 for a group)' : '(text)'))}`;
    const flagsLine = [
      this.flags.caseSensitive ? warn('[Aa]') : dim('[aa]'),
      this.flags.regex         ? warn('[.*]') : dim('[··]'),
      this.flags.wholeWord     ? warn('[w]')  : dim('[w]'),
      dim('  Alt+C/R/W toggle'),
    ].join(' ');
    const help = dim('Alt+Enter replace this · ↑↓ prev/next · Enter replace all · Esc close');

    const lines = [head, findLine, replaceLine, ...this.preview(inner), ...(this.error ? [chalk.hex(palette.error)(this.error)] : []), flagsLine, help];
    return drawBox([lines], boxWidth, border);
  }

  /** The current match's line with the match and what replaces it, cut around them to fit. */
  private preview(inner: number): string[] {
    const active = this.options.buffers.active();
    const m = this.matches[this.index];
    if (!active || !m) return [];
    const palette = getPalette();
    const line = active.buffer.getLine(m.line);
    let replacement: string | null;
    try {
      replacement = replacementFor(active.buffer, m, this.find.value, this.replace.value, this.flags);
    } catch (error) {
      if (error instanceof InvalidPatternError) return [];
      throw error;
    }
    if (replacement === null) return [];
    const label = `L${m.line + 1} `;
    const oldText = displayText(line.slice(m.col, m.col + m.length));
    const newText = displayText(replacement);
    const room = Math.max(4, inner - label.length - oldText.length - newText.length - 3);
    const before = displayText(line.slice(0, m.col)).trimStart();
    const after = displayText(line.slice(m.col + m.length));
    const lead = before.length > Math.floor(room / 2) ? `…${before.slice(before.length - Math.floor(room / 2) + 1)}` : before;
    const tail = after.length > room - lead.length ? `${after.slice(0, Math.max(0, room - lead.length - 1))}…` : after;
    return [
      chalk.hex(palette.dim)(label) + lead
      + chalk.strikethrough.hex(palette.error)(oldText) + chalk.hex(palette.dim)('→') + chalk.bold.hex(palette.ok)(newText)
      + tail,
    ];
  }

  // ── Helpers ────────────────────────────────────────────────────

  private recompute(): void {
    const active = this.options.buffers.active();
    this.error = '';
    try {
      this.matches = active ? findAll(active.buffer, this.find.value, this.flags) : [];
    } catch (error) {
      if (!(error instanceof InvalidPatternError)) throw error;
      this.matches = [];
      this.error = `Invalid regex: ${error.message}`;
    }
    // The first match at or after where the search continues from.
    const at = this.matches.findIndex((m) => positionLte(this.from, { line: m.line, col: m.col }));
    this.index = at === -1 ? 0 : at;
    this.show();
  }

  private cycle(direction: 1 | -1): void {
    if (this.matches.length === 0) return;
    this.index = (this.index + direction + this.matches.length) % this.matches.length;
    this.show();
  }

  /** Select the current match and draw them all. */
  private show(): void {
    const active = this.options.buffers.active();
    const m = this.matches[this.index];
    if (active && m) active.buffer.select({ line: m.line, col: m.col + m.length }, { line: m.line, col: m.col });
    this.options.onMatches?.(active?.id ?? null, this.matches, m ?? null);
  }

  private replaceCurrent(): void {
    const active = this.options.buffers.active();
    const m = this.matches[this.index];
    if (!active || !m) return;
    let done: boolean;
    try {
      done = replaceOne(active.buffer, m, this.find.value, this.replace.value, this.flags);
    } catch (error) {
      if (error instanceof InvalidPatternError) return;
      throw error;
    }
    if (done) this.replaced++;
    // Go on after what was put in: a replacement that contains the query is not matched again.
    this.from = done ? active.buffer.getCursor() : { line: m.line, col: m.col + m.length };
    this.recompute();
  }

  private commit(): void {
    const active = this.options.buffers.active();
    if (!active || this.find.value.length === 0) { this.close(); return; }
    let count: number;
    try {
      count = replaceAll(active.buffer, this.find.value, this.replace.value, this.flags);
    } catch (e) {
      // The box already shows the reason; Enter does nothing until the pattern is fixed.
      if (e instanceof InvalidPatternError) return;
      throw e;
    }
    this.options.onMatches?.(null, [], null);
    this.options.onCommit(this.replaced + count);
  }

  private close(): void {
    this.options.onMatches?.(null, [], null);
    if (this.replaced > 0) this.options.onCommit(this.replaced);
    else this.options.onClose();
  }

  // ── Test helpers ───────────────────────────────────────────────

  getFind():    string        { return this.find.value; }
  getReplace(): string        { return this.replace.value; }
  getFlags():   SearchOptions { return { ...this.flags }; }
  getActiveField(): Field     { return this.active; }
  getMatches(): readonly Match[] { return this.matches; }
  getIndex():   number        { return this.index; }
}
