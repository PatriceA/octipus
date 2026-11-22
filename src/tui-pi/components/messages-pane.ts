/**
 * The transcript, shared by the chat shell and the editor's chat pane.
 *
 * A list of typed items (`TranscriptItem`), each rendered once per width and
 * cached. Two ways to show it:
 *
 *   - `render(width)`: a viewport `setHeight` rows tall, scrolled by the app
 *     (PageUp/PageDown, wheel) — the inline chat and the editor's chat pane.
 *   - `documentLines(width)`: the rows of the whole window, for a scroll view
 *     that owns the scrolling — the chat on the alternate screen
 *     (`transcript-view.ts`).
 *
 * Virtualised: only the last `windowSize` items are rendered; scrolling to
 * the top of what is shown brings older items into the window, and returning
 * to the latest shrinks it again. At most `maxItems` are kept in memory; the
 * oldest are dropped beyond that, with a notice at the top saying so.
 */
import { type Component, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, displayText } from '@/tui-kit';
import { chalk, getPalette, getMarkdownTheme } from '../theme/defaults';
import type { Role } from '../gateway-adapter';
import { wheelDirection } from '../terminal-actions';
import { renderThinking, renderToolGroup, type ThinkingItem, type ToolGroupItem, toolGroupText } from './tool-group';
import { finishRows, linkPlain } from '../links';
import { renderImageItem, type ImageItem } from './image-item';

export interface ChatMessage {
  kind?: 'message';
  role: Role;
  content: string;
  timestamp: Date;
  markdown?: boolean;
  tone?: 'error' | 'notice';
}
/** A dim line that belongs to no one: what the transcript itself has to say (dropped history, more above). */
export interface TranscriptNotice { kind: 'notice'; text: string }
/**
 * What the transcript holds. A new kind (diff, image) is a new member here
 * plus a case in `renderItem`; `entries()` decides what `/copy` and
 * `/export` take from it.
 */
export type TranscriptItem = ChatMessage | TranscriptNotice | ToolGroupItem | ThinkingItem | ImageItem;
/** Items that fold: one row collapsed, everything expanded. */
export type FoldableItem = ToolGroupItem | ThinkingItem;
const isFoldable = (item: TranscriptItem): item is FoldableItem => item.kind === 'tools' || item.kind === 'thinking';

export interface MessagesPaneOptions {
  /** Initial viewport height in terminal rows. */
  maxVisible?: number;
  markdown?: boolean;
  /** Items kept in memory; older ones are dropped with a notice. Default 5,000. */
  maxItems?: number;
  /** Items rendered at once while reading the latest. Default 200. */
  windowSize?: number;
}

export const DEFAULT_MAX_ITEMS = 5_000;
export const DEFAULT_WINDOW = 200;

/** The rail every transcript row starts with: two cells, left out when a drag selection is copied. */
const RAIL = /^(?:│ |· |! | {2})/;

/** A drag selection over the transcript, without the rail drawn in front of each row. */
export function stripTranscriptRails(text: string): string {
  return text.split('\n').map(line => line.replace(RAIL, '')).join('\n');
}

/**
 * The fenced code blocks of a Markdown text, their contents only, in order.
 * A fence still open at the end (a reply streaming) runs to the end.
 */
export function codeBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let fence: { mark: string; lines: string[] } | null = null;
  for (const line of markdown.split('\n')) {
    if (!fence) {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (open && !(open[1]?.startsWith('`') && line.slice(open[0].length).includes('`'))) fence = { mark: open[1] as string, lines: [] };
      continue;
    }
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
    if (close && close[1]?.[0] === fence.mark[0] && (close[1]?.length ?? 0) >= fence.mark.length) { blocks.push(fence.lines.join('\n')); fence = null; continue; }
    fence.lines.push(line);
  }
  if (fence) blocks.push(fence.lines.join('\n'));
  return blocks;
}

const isMessage = (item: TranscriptItem): item is ChatMessage => item.kind === undefined || item.kind === 'message';

export class MessagesPane implements Component {
  private history: TranscriptItem[] = [];
  private height: number;
  private width = 80;
  private offset = 0;
  private live: string | null = null;
  /** What each message said before `displayText`: `/copy` hands over the text, not the screen's version of it. */
  private raw = new WeakMap<ChatMessage, string>();
  private liveRaw: string | null = null;
  /**
   * The streaming reply's Markdown, kept across deltas: pi-tui's Markdown
   * reuses the blocks whose source did not change, so only the block being
   * written is styled and wrapped again, and the blocks above it stay put.
   */
  private liveMarkdown: Markdown | null = null;
  private revision = 0;
  private cachedRevision = -1;
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  private historyRevision = -1;
  /** Changes to what is rendered above the live reply: items, the window, the dropped count, invalidation. */
  private itemsRevision = 0;
  private historyWidth = -1;
  private historyLines: string[] = [];
  private frozen: string[] | null = null;
  private frozenMessages: TranscriptItem[] = [];
  private frozenBlocks: number[] = [];
  private frozenWidth = 0;
  private frozenHeight = 0;
  private newer = 0;
  private messageCache = new WeakMap<TranscriptItem, { width: number; lines: string[] }>();
  private readonly maxItems: number;
  private readonly windowSize: number;
  /** Index of the first item rendered; everything before it is in memory but not drawn. */
  private windowStart = 0;
  /** Items dropped from memory over `maxItems`. */
  private dropped = 0;
  private notice: { text: string; item: TranscriptNotice } | null = null;
  /** Where each item of the rendered window starts, in `documentLines` rows. */
  private itemRows: Array<{ item: TranscriptItem; start: number; end: number }> = [];
  /** Whether new tool groups and thinking items start expanded (`app.tools.toggle`). */
  private detail = false;

  constructor(private readonly options: MessagesPaneOptions = {}) {
    this.height = options.maxVisible ?? 30;
    this.maxItems = Math.max(1, options.maxItems ?? DEFAULT_MAX_ITEMS);
    this.windowSize = Math.max(1, options.windowSize ?? DEFAULT_WINDOW);
  }
  setHeight(rows: number): void { this.height = Math.max(0, rows); }
  /**
   * Whether the latest rows are what is shown, so the window may follow the
   * end. The pane's own viewport knows; a scroll view that shows
   * `documentLines` replaces this with its own answer.
   */
  readingLatest: () => boolean = () => !this.frozen;
  /** Scroll the in-app transcript; terminal scrollback contains only painted rows. */
  handleScrollInput(data: string): boolean {
    const wheel = wheelDirection(data);
    if (wheel) {
      if (wheel === 'up') this.scrollUp(3); else this.scrollDown(3);
      return true;
    }
    if (matchesKey(data, 'pageUp')) { this.scrollUp(); return true; }
    if (matchesKey(data, 'pageDown')) { this.scrollDown(); return true; }
    if (matchesKey(data, 'ctrl+home')) { this.scrollUp(Number.MAX_SAFE_INTEGER); return true; }
    if (matchesKey(data, 'ctrl+end') || (matchesKey(data, 'end') && this.offset > 0)) { this.scrollToBottom(); return true; }
    return false;
  }
  push(message: ChatMessage): void {
    const shown = { ...message, content: displayText(message.content) };
    this.raw.set(shown, message.content);
    this.pushItem(shown);
  }
  /** Add an item of any kind. Messages go through `push`, which also keeps their raw text for `/copy`. */
  pushItem(item: TranscriptItem): void {
    this.history.push(item);
    if (this.history.length > this.maxItems) {
      const excess = this.history.length - this.maxItems;
      this.history.splice(0, excess);
      this.dropped += excess;
      this.windowStart = Math.max(0, this.windowStart - excess);
    }
    // While reading the latest, the window follows the end instead of growing without bound.
    if (this.readingLatest() && this.history.length - this.windowStart > this.windowSize * 2) this.windowStart = this.history.length - this.windowSize;
    if (this.frozen) this.newer++;
    this.changed();
  }
  /** An item already in the transcript changed (a tool call finished): draw it again. False when it is not (any more) in the transcript. */
  update(item: TranscriptItem): boolean {
    this.messageCache.delete(item);
    if (!this.history.includes(item)) return false;
    this.changed();
    return true;
  }
  /** Expand or collapse every tool group and thinking item, and the ones still to come. */
  setDetail(expanded: boolean): void {
    this.detail = expanded;
    for (const item of this.history) if (isFoldable(item) && item.expanded !== expanded) { item.expanded = expanded; this.messageCache.delete(item); }
    this.changed();
  }
  getDetail(): boolean { return this.detail; }
  /** Expand or collapse one item. */
  toggle(item: FoldableItem): void {
    item.expanded = !item.expanded;
    this.update(item);
  }
  /** The foldable item whose first (summary) row is `row` of `documentLines`, if any. */
  foldableAt(row: number): FoldableItem | null {
    const hit = this.itemRows.find(entry => entry.start === row);
    return hit && isFoldable(hit.item) ? hit.item : null;
  }
  setLive(raw: string | null): void {
    const text = raw === null ? null : displayText(raw);
    this.liveRaw = raw;
    if (this.live !== text) { this.live = text; this.revision++; }
  }
  reset(): void {
    this.history = []; this.live = null; this.liveRaw = null; this.offset = 0; this.windowStart = 0; this.dropped = 0;
    this.frozen = null; this.frozenMessages = []; this.newer = 0; this.changed();
  }
  /** Older items in memory that the window does not show yet. */
  canGrow(): boolean { return this.windowStart > 0; }
  /** Bring up to one more window of older items into view. */
  growWindow(): boolean {
    if (!this.windowStart) return false;
    this.windowStart = Math.max(0, this.windowStart - this.windowSize);
    this.changed();
    return true;
  }
  /** Back to the latest window; call only while the end is shown. */
  trimWindow(): void {
    const start = Math.max(0, this.history.length - this.windowSize);
    if (start > this.windowStart) { this.windowStart = start; this.changed(); }
  }
  /** How many items are in memory, and how many were dropped (tests, the exit summary). */
  size(): { kept: number; dropped: number; rendered: number } {
    return { kept: this.history.length, dropped: this.dropped, rendered: this.history.length - this.windowStart };
  }
  scrollUp(by = Math.max(1, this.height - 2)): boolean {
    let lines = this.frozen ?? this.lines(this.width);
    let max = Math.max(0, lines.length - Math.max(1, this.height - 1));
    // Reading past the oldest row rendered: bring older items in. The offset counts from the bottom, so it holds.
    while (this.offset + by > max && this.windowStart > 0) {
      this.growWindow();
      if (this.frozen) this.refreeze();
      lines = this.frozen ?? this.lines(this.width);
      max = Math.max(0, lines.length - Math.max(1, this.height - 1));
    }
    const next = Math.min(max, this.offset + by);
    if (next === this.offset) return false;
    if (!this.frozen) this.freeze(lines);
    this.offset = next;
    return true;
  }
  scrollDown(by = Math.max(1, this.height - 2)): boolean {
    if (!this.offset) return false;
    this.offset = Math.max(0, this.offset - by);
    if (!this.offset) this.scrollToBottom();
    return true;
  }
  scrollToBottom(): void { this.offset = 0; this.frozen = null; this.frozenMessages = []; this.newer = 0; this.trimWindow(); }
  /** Raw text, independent of viewport width/scroll and rendered ANSI styling. */
  getCopyText(scope: 'last' | 'transcript' | 'code'): string {
    const all = this.entries();
    if (scope === 'last') return all.findLast(message => message.role === 'assistant' && message.content.length > 0)?.content ?? '';
    if (scope === 'code') {
      for (const message of all.toReversed()) {
        if (message.role !== 'assistant') continue;
        const blocks = codeBlocks(message.content);
        if (blocks.length) return blocks.at(-1) ?? '';
      }
      return '';
    }
    return all.map(message => `${message.role}:\n${message.content}`).join('\n\n');
  }
  /**
   * Every message kept, as received, oldest first — with the reply still
   * streaming, if any. A tool group is a system entry, one line per call; a
   * thinking item is a system entry too, so `/copy last` still takes the
   * reply and not the reasoning before it.
   */
  entries(): Array<{ role: Role; content: string; timestamp: Date }> {
    const all = this.history.flatMap(item => {
      if (isMessage(item)) return [{ role: item.role, content: this.raw.get(item) ?? item.content, timestamp: item.timestamp }];
      if (item.kind === 'tools' && item.calls.length) return [{ role: 'system' as const, content: toolGroupText(item), timestamp: new Date(item.calls[0]?.startedAt ?? Date.now()) }];
      if (item.kind === 'thinking') return [{ role: 'system' as const, content: `Thinking:\n${item.text}`, timestamp: new Date() }];
      if (item.kind === 'image') return [{ role: 'system' as const, content: `[image: ${item.name}]`, timestamp: new Date() }];
      return [];
    });
    if (this.liveRaw) all.push({ role: 'assistant', content: this.liveRaw, timestamp: new Date() });
    return all;
  }
  getScrollOffset(): number { return this.offset; }
  invalidate(): void { this.messageCache = new WeakMap(); this.liveMarkdown = null; this.changed(); }
  private changed(): void { this.itemsRevision++; this.revision++; }

  /** All rows of the rendered window, for a scroll view; the same array while nothing changed. */
  documentLines(width: number): string[] { return this.lines(Math.max(1, width)); }

  private freeze(lines: string[]): void {
    this.frozen = lines.slice();
    this.frozenMessages = this.allMessages();
    this.frozenBlocks = this.blocks(this.frozenMessages, this.width);
    this.frozenWidth = this.width;
    this.frozenHeight = this.height;
  }

  /** The window grew while reading: put the older items above what is frozen, keeping its bottom. */
  private refreeze(): void {
    const kept = this.frozenMessages.filter(item => item.kind !== 'notice');
    const first = kept[0];
    const at = first ? this.history.indexOf(first) : this.history.length;
    this.frozenMessages = [...this.prefix(), ...this.history.slice(this.windowStart, at < 0 ? this.windowStart : at), ...kept];
    this.frozen = this.renderMessages(this.frozenMessages, this.width);
    this.frozenBlocks = this.blocks(this.frozenMessages, this.width);
  }

  /** Rows each item takes, with the blank separator before it. */
  private blocks(items: TranscriptItem[], width: number): number[] {
    this.renderMessages(items, width);
    return items.map((item, index) => (this.messageCache.get(item)?.lines.length ?? 0) + (index ? 1 : 0));
  }

  private lines(width: number): string[] {
    if (width === this.cachedWidth && this.revision === this.cachedRevision) return this.cachedLines;
    // Rendering the history is the expensive part; streaming re-renders only the live reply below it.
    if (this.historyWidth !== width || this.historyRevision !== this.itemsRevision) {
      this.historyLines = this.renderMessages(this.windowItems(), width, this.itemRows = []);
      this.historyWidth = width;
      this.historyRevision = this.itemsRevision;
    }
    const live = this.liveItem();
    this.cachedLines = live ? this.historyLines.concat(this.historyLines.length ? [''] : [], this.renderItem(live, width, true)) : this.historyLines;
    this.cachedWidth = width; this.cachedRevision = this.revision;
    return this.cachedLines;
  }

  private liveItem(): ChatMessage | null {
    return this.live ? { role: 'assistant', content: this.live, timestamp: new Date() } : null;
  }

  /** The notice at the top of the window, when something is above it or was dropped. */
  private prefix(): TranscriptNotice[] {
    const text = this.windowStart > 0
      ? `↑ ${this.windowStart.toLocaleString('en-US')} earlier message${this.windowStart === 1 ? '' : 's'} above — scroll up to show them`
      : this.dropped > 0
        ? `${this.dropped.toLocaleString('en-US')} earlier message${this.dropped === 1 ? ' is' : 's are'} no longer kept here (limit ${this.maxItems.toLocaleString('en-US')}); /history reloads the latest from the server`
        : null;
    if (text === null) return [];
    if (this.notice?.text !== text) this.notice = { text, item: { kind: 'notice', text } };
    return [this.notice.item];
  }

  private windowItems(): TranscriptItem[] { return [...this.prefix(), ...this.history.slice(this.windowStart)]; }

  private allMessages(): TranscriptItem[] {
    const live = this.liveItem();
    return live ? [...this.windowItems(), live] : this.windowItems();
  }

  /**
   * `live`: the reply still streaming. It renders exactly as the finished
   * message with the same text will, so the reply does not jump when it
   * completes; mid-stream an unterminated code fence is a code block that
   * runs to the end and a table shows the rows that arrived.
   */
  private renderItem(item: TranscriptItem, width: number, live = false): string[] {
    const cached = this.messageCache.get(item);
    if (cached?.width === width) return cached.lines;
    const p = getPalette();
    const inner = Math.max(1, width - 2);
    const lines: string[] = [];
    if (item.kind === 'notice') {
      for (const line of wrapTextWithAnsi(item.text, inner)) lines.push(chalk.hex(p.dim)(`· ${line}`));
    } else if (item.kind === 'tools') {
      lines.push(...renderToolGroup(item, width));
    } else if (item.kind === 'thinking') {
      lines.push(...renderThinking(item, width));
    } else if (item.kind === 'image') {
      lines.push(...renderImageItem(item, width));
    } else {
      const error = item.tone === 'error';
      const colour = error ? p.error : item.role === 'user' ? p.accent : p.dim;
      if (item.role !== 'system') {
        lines.push(chalk.bold.hex(item.role === 'user' ? p.accent : p.fg)(item.role === 'user' ? 'You' : 'Octipus'));
      }
      const markdown = item.role === 'assistant' && this.options.markdown !== false && item.markdown !== false;
      const body = markdown
        ? finishRows(this.markdownFor(item.content, live).render(inner))
        : wrapTextWithAnsi(linkPlain((error ? 'Error · ' : '') + item.content), inner);
      for (const line of body) {
        const rail = item.role === 'user' ? chalk.hex(p.accent)('│ ') : item.role === 'system' ? chalk.hex(colour)(error ? '! ' : '· ') : '  ';
        lines.push(rail + (item.role === 'system' ? chalk.hex(colour)(line) : item.role === 'user' ? chalk.hex(p.fg)(line) : line));
      }
    }
    this.messageCache.set(item, { width, lines });
    return lines;
  }

  private markdownFor(text: string, live: boolean): Markdown {
    if (!live) return new Markdown(text, 0, 0, getMarkdownTheme());
    if (!this.liveMarkdown) this.liveMarkdown = new Markdown(text, 0, 0, getMarkdownTheme());
    else this.liveMarkdown.setText(text);
    return this.liveMarkdown;
  }

  private renderMessages(all: TranscriptItem[], width: number, rows?: Array<{ item: TranscriptItem; start: number; end: number }>): string[] {
    const lines: string[] = [];
    for (const [index, item] of all.entries()) {
      if (index) lines.push('');
      const rendered = this.renderItem(item, width);
      rows?.push({ item, start: lines.length, end: lines.length + rendered.length });
      for (const line of rendered) lines.push(line);
    }
    return lines;
  }

  render(width: number): string[] {
    this.width = Math.max(1, width);
    if (this.height === 0 || width <= 0) return [];
    // Freeze message content while reading, but reflow it when the pane changes
    // width. Anchor within the same message instead of clipping its right edge.
    if (this.frozen && (width !== this.frozenWidth || this.height !== this.frozenHeight)) {
      const budget = Math.max(0, this.height - 1);
      let row = Math.max(0, this.frozen.length - this.offset - Math.max(0, this.frozenHeight - 1));
      let index = 0;
      while (index < this.frozenBlocks.length - 1 && row >= this.frozenBlocks[index]) row -= this.frozenBlocks[index++];
      const fraction = row / Math.max(1, this.frozenBlocks[index] ?? 1);
      this.frozen = this.renderMessages(this.frozenMessages, width);
      this.frozenBlocks = this.blocks(this.frozenMessages, width);
      const top = this.frozenBlocks.slice(0, index).reduce((sum, size) => sum + size, 0) + Math.floor(fraction * (this.frozenBlocks[index] ?? 0));
      this.offset = Math.max(1, this.frozen.length - top - budget);
      this.frozenWidth = width;
      this.frozenHeight = this.height;
    }
    const lines = this.frozen ?? this.lines(width);
    const hint = this.offset > 0 || lines.length > this.height;
    const budget = Math.max(0, this.height - (hint ? 1 : 0));
    const end = Math.max(0, lines.length - this.offset);
    const start = Math.max(0, end - budget);
    const out = lines.slice(start, end).map(line => truncateToWidth(line, width, ''));
    if (hint) {
      const label = truncateToWidth(this.offset > 0
      ? `End: latest · PgUp/PgDn · ↑ ${start} ↓ ${this.offset}${this.newer ? ` · ${this.newer} new` : ''}`
      : `PgUp/PgDn or wheel: history · Ctrl+Home: oldest · ↑ ${start} rows`, width, '');
      out.push(' '.repeat(Math.max(0, width - visibleWidth(label))) + chalk.hex(getPalette().dim)(label));
    }
    return out;
  }
}
