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
} from '@/tui-kit';
import { drawBox } from '@/tui-kit/overlay-frame';
import { listEditorKeybindings } from '../keybindings';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

export interface HotkeysOverlayOptions {
  onClose: () => void;
}

export class HotkeysOverlay implements Component, Focusable {
  focused = false;
  private scroll = 0;
  private maxRows = Number.POSITIVE_INFINITY;

  constructor(private readonly options: HotkeysOverlayOptions) {}

  invalidate(): void { /* static content */ }

  /** The rows the overlay frame gives the box. */
  setMaxRows(rows: number): void { this.maxRows = rows; }

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

    const all = listEditorKeybindings(getKeybindings());
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
    for (const [title, section] of [['EDITOR', EDIT_KEYS], ['FILE TREE (focused)', TREE_KEYS], ['AGENT EDIT REVIEW', REVIEW_KEYS], ['VIM (when on)', VIM_KEYS]] as const) {
      body.push('');
      body.push(heading(title));
      for (const [keys, what] of section) body.push(`  ${chalk.hex(palette.warn)(keys.padEnd(keyWidth))}${dim('  ')}${what}`);
    }

    const boxWidth = Math.max(20, width);
    const help = dim('↑/↓/PgUp/PgDn scroll · Esc close');

    // A fixed-size viewport that fills the rows the overlay frame gives the
    // box (`setMaxRows`), so the box scrolls instead of shrinking and its
    // footer and bottom border stay on screen.
    const budget = Number.isFinite(this.maxRows) ? this.maxRows : Math.max(8, Math.floor((process.stdout.rows ?? 24) * 0.85));
    const viewport = Math.max(1, Math.min(body.length, budget - 3)); // top + footer + bottom
    const maxScroll = Math.max(0, body.length - viewport);
    if (this.scroll > maxScroll) this.scroll = maxScroll;

    const window = body.slice(this.scroll, this.scroll + viewport);
    while (window.length < viewport) window.push('');

    const indicator = body.length > viewport
      ? dim(`  · ${this.scroll + 1}–${Math.min(body.length, this.scroll + viewport)} of ${body.length}`)
      : '';
    return drawBox([[...window, `${help}${indicator}`]], boxWidth, border);
  }
}

/** The editor pane's own keys; they are not rebindable. */
const EDIT_KEYS: ReadonlyArray<[keys: string, what: string]> = [
  ['PgUp / PgDn', 'Page up / down'],
  ['Ctrl+Home / End', 'Start / end of the buffer'],
  ['Shift+motion', 'Select (arrows, Home/End, pages, Ctrl+arrows)'],
  ['Ctrl+X / Ctrl+V', 'Cut / paste (Ctrl+C copies a selection)'],
  ['Mouse', 'Click: cursor · drag: select and copy · double click: word'],
];

/** Keys of the file tree when it has the focus. */
const TREE_KEYS: ReadonlyArray<[keys: string, what: string]> = [
  ['Enter', 'Open the file, expand or collapse the folder'],
  ['n', 'New file in the selected folder'],
  ['m', 'Rename (move) the selected file or folder'],
  ['d / Delete', 'Delete the selected file (asks first)'],
  ['r', 'Read the folders again'],
];

/** Keys of the agent edit review. */
const REVIEW_KEYS: ReadonlyArray<[keys: string, what: string]> = [
  ['y / n', 'Accept / reject this hunk, then go to the next'],
  ['] / [', 'Next / previous hunk'],
  ['Space', 'Flip this hunk between accepted and rejected'],
  ['z', 'Fold / unfold unchanged lines'],
  ['Enter', 'Apply: every hunk not rejected'],
  ['a / r, Esc', 'Accept all / reject all'],
];

/** Vim mode's own keys and commands; they are not rebindable. */
const VIM_KEYS: ReadonlyArray<[keys: string, what: string]> = [
  ['Esc', 'NORMAL mode'],
  ['i / a / o', 'INSERT mode (at, after, on a new line)'],
  ['v', 'VISUAL mode: motions select'],
  [':w', 'Save'],
  [':q / :q!', 'Close the buffer / close it discarding changes'],
  [':wq / :x', 'Save and close the buffer'],
  [':qa / :qa!', 'Quit the editor / quit discarding changes'],
];

function groupBindings(all: ReturnType<typeof listEditorKeybindings>): Array<[title: string, entries: typeof all]> {
  const buckets: Record<string, typeof all> = {};
  for (const b of all) {
    const namespace = b.id.split('.')[0];
    (buckets[namespace] ??= []).push(b);
  }
  const order = ['app', ...Object.keys(buckets).filter((n) => n !== 'app').sort()];
  return order.filter((n) => buckets[n]).map((n) => [n.toUpperCase(), buckets[n]]);
}
