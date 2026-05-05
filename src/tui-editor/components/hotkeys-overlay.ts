/**
 * Read-only overlay listing the editor's keyboard shortcuts.
 *
 * Sources from the live KeybindingsManager so user overrides in
 * `~/.octipus/keybindings.json` show up immediately without a
 * separate config touch.
 *
 * Renders to fill the requested overlay width (so anchor:'center'
 * actually centers it) and supports up/down/page scroll for hosts
 * where the binding list overflows the available height.
 */
import {
  type Component,
  type Focusable,
  getKeybindings,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from '@mariozechner/pi-tui';
import { listAllKeybindings } from '@/tui-pi/keybindings';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

export interface HotkeysOverlayOptions {
  onClose: () => void;
}

export class HotkeysOverlay implements Component, Focusable {
  focused = false;
  private scroll = 0;

  constructor(private readonly options: HotkeysOverlayOptions) {}

  invalidate(): void { /* static content */ }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'q')) { this.options.onClose(); return; }
    if (matchesKey(data, 'enter')) { this.options.onClose(); return; }
    if (matchesKey(data, 'up'))       { this.scroll = Math.max(0, this.scroll - 1); return; }
    if (matchesKey(data, 'down'))     { this.scroll = this.scroll + 1; return; }
    if (matchesKey(data, 'pageUp'))   { this.scroll = Math.max(0, this.scroll - 10); return; }
    if (matchesKey(data, 'pageDown')) { this.scroll = this.scroll + 10; return; }
    if (matchesKey(data, 'home'))     { this.scroll = 0; return; }
  }

  render(width: number): string[] {
    const palette = getPalette();
    const border = (text: string) => chalk.hex(palette.border)(text);
    const dim    = (text: string) => chalk.hex(palette.dim)(text);
    const accent = (text: string) => chalk.hex(palette.accent)(text);
    const heading = (text: string) => chalk.bold.hex(palette.accent)(text);

    const all = listAllKeybindings(getKeybindings());
    const groups = groupBindings(all);
    const keyWidth = Math.max(8, ...all.flatMap((b) => b.keys.map((k) => k.length))) + 2;

    const body: string[] = [accent('Octipus — keybindings')];
    for (const [title, entries] of groups) {
      body.push('');
      body.push(heading(title));
      for (const entry of entries) {
        const keys = entry.keys.length === 0 ? '(unbound)' : entry.keys.join(' / ');
        body.push(`  ${chalk.hex(palette.warn)(keys.padEnd(keyWidth))}${dim('  ')}${entry.description || entry.id}`);
      }
    }

    const boxWidth = Math.max(20, width);
    const inner = boxWidth - 4;
    const help = dim('↑/↓/PgUp/PgDn scroll · Esc close');

    // pi-tui's overlay system passes width into render() but not the
    // available height, and clips overflow rows via maxHeight after the
    // fact — meaning if we just slice from `scroll` the box itself shrinks
    // instead of scrolling. So we read the terminal height directly
    // (matching the 85% maxHeight in overlays/registry.ts), reserve rows
    // for the box chrome, and produce a fixed-size viewport that always
    // fills the same height regardless of scroll position.
    const termRows = process.stdout.rows ?? Number(process.env.LINES ?? 24);
    const overlayBudget = Math.max(8, Math.floor(termRows * 0.85));
    const viewport = Math.max(3, overlayBudget - 4); // top + bottom + footer + margin
    const maxScroll = Math.max(0, body.length - viewport);
    if (this.scroll > maxScroll) this.scroll = maxScroll;

    const window = body.slice(this.scroll, this.scroll + viewport);
    while (window.length < viewport) window.push('');

    const top    = border('┌' + '─'.repeat(boxWidth - 2) + '┐');
    const middle = (text: string) => border('│ ') + padTo(truncateToWidth(text, inner), inner) + border(' │');
    const bottom = border('└' + '─'.repeat(boxWidth - 2) + '┘');
    const indicator = body.length > viewport
      ? dim(`  · ${this.scroll + 1}–${Math.min(body.length, this.scroll + viewport)} of ${body.length}`)
      : '';
    const footer = middle(`${help}${indicator}`);

    return [top, ...window.map(middle), footer, bottom];
  }
}

function groupBindings(all: ReturnType<typeof listAllKeybindings>): Array<[title: string, entries: typeof all]> {
  const buckets: Record<string, typeof all> = {};
  for (const b of all) {
    const namespace = b.id.split('.')[0];
    (buckets[namespace] ??= []).push(b);
  }
  const order = ['app', ...Object.keys(buckets).filter((n) => n !== 'app').sort()];
  return order.filter((n) => buckets[n]).map((n) => [n.toUpperCase(), buckets[n]]);
}

function padTo(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return text;
  return text + ' '.repeat(width - w);
}
