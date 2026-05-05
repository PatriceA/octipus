/**
 * Replace overlay (Ctrl+H).
 *
 * Two inline fields (find / replace) navigated with Tab. Enter runs
 * `replaceAll`, closes the overlay, and reports the match count via
 * `onCommit`. Same flag toggles as FindOverlay (Alt+C/R/W).
 */
import {
  type Component,
  type Focusable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from '@mariozechner/pi-tui';
import { findAll, replaceAll, type SearchOptions } from '../editor/search';
import type { BufferStore } from '../stores/buffer-store';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

const PRINTABLE = /^[^\x00-\x1f\x7f]$/u;

type Field = 'find' | 'replace';

export interface ReplaceOverlayOptions {
  buffers: BufferStore;
  onCommit: (count: number) => void;
  onClose: () => void;
}

export class ReplaceOverlay implements Component, Focusable {
  focused = false;
  private active: Field = 'find';
  private find = '';
  private replace = '';
  private flags: SearchOptions = { caseSensitive: false, regex: false, wholeWord: false };

  constructor(private readonly options: ReplaceOverlayOptions) {}

  invalidate(): void { /* recomputed each render */ }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) { this.options.onClose(); return; }
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      this.active = this.active === 'find' ? 'replace' : 'find'; return;
    }
    if (matchesKey(data, 'enter')) { this.commit(); return; }
    if (matchesKey(data, 'backspace')) {
      const value = this.activeValue();
      if (value.length === 0 && this.active === 'find') { this.options.onClose(); return; }
      this.setActive(value.slice(0, -1));
      return;
    }
    if (matchesKey(data, 'alt+c')) { this.flags.caseSensitive = !this.flags.caseSensitive; return; }
    if (matchesKey(data, 'alt+r')) { this.flags.regex          = !this.flags.regex;          return; }
    if (matchesKey(data, 'alt+w')) { this.flags.wholeWord      = !this.flags.wholeWord;      return; }
    if (data.length === 1 && PRINTABLE.test(data)) {
      this.setActive(this.activeValue() + data);
    }
  }

  render(width: number): string[] {
    const palette = getPalette();
    const border = (text: string) => chalk.hex(palette.border)(text);
    const dim = (text: string) => chalk.hex(palette.dim)(text);
    const accent = (text: string) => chalk.hex(palette.accent)(text);
    const warn = (text: string) => chalk.hex(palette.warn)(text);

    const buffersActive = this.options.buffers.active();
    const previewCount = buffersActive ? findAll(buffersActive.buffer, this.find, this.flags).length : 0;

    const head = accent(`Replace${previewCount > 0 ? ` (${previewCount} match${previewCount === 1 ? '' : 'es'})` : ''}`);
    const findLabel = this.active === 'find'    ? accent('find:')    : dim('find:');
    const repLabel  = this.active === 'replace' ? accent('replace:') : dim('replace:');
    const findLine    = `${findLabel} ${this.find    || dim('(text)')}`;
    const replaceLine = `${repLabel} ${this.replace || dim('(text)')}`;
    const flagsLine = [
      this.flags.caseSensitive ? warn('[Aa]') : dim('[aa]'),
      this.flags.regex         ? warn('[.*]') : dim('[··]'),
      this.flags.wholeWord     ? warn('[w]')  : dim('[w]'),
      dim('  Alt+C/R/W toggle'),
    ].join(' ');
    const help = dim('Tab switch · Enter replace all · Esc close');

    const lines = [head, findLine, replaceLine, flagsLine, help];
    const innerWidth = Math.max(...lines.map(visibleWidth));
    const boxWidth = Math.min(width, innerWidth + 4);
    const inner = boxWidth - 4;
    const top    = border('┌' + '─'.repeat(boxWidth - 2) + '┐');
    const middle = (text: string) => border('│ ') + padTo(truncateToWidth(text, inner), inner) + border(' │');
    const bottom = border('└' + '─'.repeat(boxWidth - 2) + '┘');
    return [top, ...lines.map(middle), bottom];
  }

  // ── Helpers ────────────────────────────────────────────────────

  private commit(): void {
    const active = this.options.buffers.active();
    if (!active || this.find.length === 0) { this.options.onClose(); return; }
    const count = replaceAll(active.buffer, this.find, this.replace, this.flags);
    if (count > 0) this.options.buffers.markDirty(active.id, true);
    this.options.onCommit(count);
  }

  private activeValue(): string { return this.active === 'find' ? this.find : this.replace; }
  private setActive(value: string): void {
    if (this.active === 'find') this.find = value; else this.replace = value;
  }

  // ── Test helpers ───────────────────────────────────────────────

  getFind():    string        { return this.find; }
  getReplace(): string        { return this.replace; }
  getFlags():   SearchOptions { return { ...this.flags }; }
  getActiveField(): Field     { return this.active; }
}

function padTo(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return text;
  return text + ' '.repeat(width - w);
}
