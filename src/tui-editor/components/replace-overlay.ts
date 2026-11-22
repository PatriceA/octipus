/**
 * Replace overlay (Alt+R).
 *
 * Two fields (find / replace) navigated with Tab. Enter runs
 * `replaceAll` — one undo step — closes the overlay, and reports the
 * match count via `onCommit`. Same flag toggles as FindOverlay
 * (Alt+C/R/W). In regex mode the replacement expands `$1`, `$<name>`,
 * `$&` and `$$`.
 *
 * Both fields are `TextField`s: paste, emoji and IME input work.
 */
import {
  type Component,
  type Focusable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from '@/tui-kit';
import { findAll, InvalidPatternError, replaceAll, type SearchOptions } from '../editor/search';
import type { BufferStore } from '../stores/buffer-store';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';
import { TextField } from './text-field';

type Field = 'find' | 'replace';

export interface ReplaceOverlayOptions {
  buffers: BufferStore;
  onCommit: (count: number) => void;
  onClose: () => void;
}

export class ReplaceOverlay implements Component, Focusable {
  focused = false;
  private active: Field = 'find';
  private readonly find = new TextField();
  private readonly replace = new TextField();
  private flags: SearchOptions = { caseSensitive: false, regex: false, wholeWord: false };

  constructor(private readonly options: ReplaceOverlayOptions) {}

  invalidate(): void { /* recomputed each render */ }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) { this.options.onClose(); return; }
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      this.active = this.active === 'find' ? 'replace' : 'find'; return;
    }
    if (matchesKey(data, 'enter')) { this.commit(); return; }
    if (matchesKey(data, 'backspace') && this.active === 'find' && this.find.value === '') { this.options.onClose(); return; }
    if (matchesKey(data, 'alt+c')) { this.flags.caseSensitive = !this.flags.caseSensitive; return; }
    if (matchesKey(data, 'alt+r')) { this.flags.regex          = !this.flags.regex;          return; }
    if (matchesKey(data, 'alt+w')) { this.flags.wholeWord      = !this.flags.wholeWord;      return; }
    (this.active === 'find' ? this.find : this.replace).handleInput(data);
  }

  render(width: number): string[] {
    const palette = getPalette();
    const border = (text: string) => chalk.hex(palette.border)(text);
    const dim = (text: string) => chalk.hex(palette.dim)(text);
    const accent = (text: string) => chalk.hex(palette.accent)(text);
    const warn = (text: string) => chalk.hex(palette.warn)(text);

    const buffersActive = this.options.buffers.active();
    let previewCount = 0;
    let error = '';
    try {
      previewCount = buffersActive ? findAll(buffersActive.buffer, this.find.value, this.flags).length : 0;
    } catch (e) {
      if (!(e instanceof InvalidPatternError)) throw e;
      error = `Invalid regex: ${e.message}`;
    }

    const boxWidth = Math.min(width, 64);
    const inner = Math.max(1, boxWidth - 4);
    const head = accent(`Replace${previewCount > 0 ? ` (${previewCount} match${previewCount === 1 ? '' : 'es'})` : ''}`);
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
    const help = dim('Tab switch · Enter replace all · Esc close');

    const lines = [head, findLine, replaceLine, ...(error ? [chalk.hex(palette.error)(error)] : []), flagsLine, help];
    const top    = border('┌' + '─'.repeat(Math.max(0, boxWidth - 2)) + '┐');
    const middle = (text: string) => border('│ ') + padTo(truncateToWidth(text, inner), inner) + border(' │');
    const bottom = border('└' + '─'.repeat(Math.max(0, boxWidth - 2)) + '┘');
    return [top, ...lines.map(middle), bottom];
  }

  // ── Helpers ────────────────────────────────────────────────────

  private commit(): void {
    const active = this.options.buffers.active();
    if (!active || this.find.value.length === 0) { this.options.onClose(); return; }
    let count: number;
    try {
      count = replaceAll(active.buffer, this.find.value, this.replace.value, this.flags);
    } catch (e) {
      // The box already shows the reason; Enter does nothing until the pattern is fixed.
      if (e instanceof InvalidPatternError) return;
      throw e;
    }
    this.options.onCommit(count);
  }

  // ── Test helpers ───────────────────────────────────────────────

  getFind():    string        { return this.find.value; }
  getReplace(): string        { return this.replace.value; }
  getFlags():   SearchOptions { return { ...this.flags }; }
  getActiveField(): Field     { return this.active; }
}

function padTo(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return text;
  return text + ' '.repeat(width - w);
}
