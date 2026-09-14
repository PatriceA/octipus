/** Shared, row-scrolled transcript for the chat shell and editor. */
import { type Component, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@mariozechner/pi-tui';
import { chalk, getPalette, getMarkdownTheme } from '../theme/defaults';
import type { Role } from '../gateway-adapter';

export interface ChatMessage {
  role: Role;
  content: string;
  timestamp: Date;
  markdown?: boolean;
  tone?: 'error' | 'notice';
}
export interface MessagesPaneOptions {
  /** Initial viewport height in terminal rows. */
  maxVisible?: number;
  markdown?: boolean;
}

export class MessagesPane implements Component {
  private mouseCaptured = false;
  setMouseCaptured(enabled: boolean): void { this.mouseCaptured = enabled; }
  private history: ChatMessage[] = [];
  private height: number;
  private width = 80;
  private offset = 0;
  private live: string | null = null;
  private revision = 0;
  private cachedRevision = -1;
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  private frozen: string[] | null = null;
  private frozenMessages: ChatMessage[] = [];
  private frozenBlocks: number[] = [];
  private frozenWidth = 0;
  private frozenHeight = 0;
  private newer = 0;
  private messageCache = new WeakMap<ChatMessage, { width: number; lines: string[] }>();

  constructor(private readonly options: MessagesPaneOptions = {}) {
    this.height = options.maxVisible ?? 30;
  }
  setHeight(rows: number): void { this.height = Math.max(0, rows); }
  /** Scroll the in-app transcript; terminal scrollback contains only painted rows. */
  handleScrollInput(data: string): boolean {
    const mouse = /^\x1b\[<(\d+);\d+;\d+M$/.exec(data);
    if (mouse && (Number(mouse[1]) & 64)) {
      if ((Number(mouse[1]) & 3) === 0) this.scrollUp(3);
      else if ((Number(mouse[1]) & 3) === 1) this.scrollDown(3);
      return true;
    }
    if (matchesKey(data, 'pageUp')) { this.scrollUp(); return true; }
    if (matchesKey(data, 'pageDown')) { this.scrollDown(); return true; }
    if (matchesKey(data, 'ctrl+home')) { this.scrollUp(Number.MAX_SAFE_INTEGER); return true; }
    if (matchesKey(data, 'ctrl+end') || (matchesKey(data, 'end') && this.offset > 0)) { this.scrollToBottom(); return true; }
    return false;
  }
  push(message: ChatMessage): void {
    this.history.push(message);
    if (this.frozen) this.newer++;
    this.revision++;
  }
  setLive(text: string | null): void {
    if (this.live !== text) { this.live = text; this.revision++; }
  }
  reset(): void {
    this.history = []; this.live = null; this.offset = 0;
    this.frozen = null; this.frozenMessages = []; this.newer = 0; this.revision++;
  }
  scrollUp(by = Math.max(1, this.height - 2)): boolean {
    const lines = this.frozen ?? this.lines(this.width);
    const next = Math.min(Math.max(0, lines.length - Math.max(1, this.height - 1)), this.offset + by);
    if (next === this.offset) return false;
    if (!this.frozen) {
      this.frozen = lines.slice();
      this.frozenMessages = this.allMessages();
      // Include the blank separator before each message in its row budget.
      this.renderMessages(this.frozenMessages, this.width);
      this.frozenBlocks = this.frozenMessages.map((message, index) => (this.messageCache.get(message)?.lines.length ?? 0) + (index ? 1 : 0));
      this.frozenWidth = this.width;
      this.frozenHeight = this.height;
    }
    this.offset = next;
    return true;
  }
  scrollDown(by = Math.max(1, this.height - 2)): boolean {
    if (!this.offset) return false;
    this.offset = Math.max(0, this.offset - by);
    if (!this.offset) this.scrollToBottom();
    return true;
  }
  scrollToBottom(): void { this.offset = 0; this.frozen = null; this.frozenMessages = []; this.newer = 0; }
  /** Raw text, independent of viewport width/scroll and rendered ANSI styling. */
  getCopyText(scope: 'last' | 'transcript'): string {
    const all = this.allMessages();
    if (scope === 'last') return all.findLast(message => message.role === 'assistant' && message.content.length > 0)?.content ?? '';
    return all.map(message => `${message.role}:\n${message.content}`).join('\n\n');
  }
  getScrollOffset(): number { return this.offset; }
  invalidate(): void { this.messageCache = new WeakMap(); this.revision++; }

  private lines(width: number): string[] {
    if (width === this.cachedWidth && this.revision === this.cachedRevision) return this.cachedLines;
    this.cachedLines = this.renderMessages(this.allMessages(), width);
    this.cachedWidth = width; this.cachedRevision = this.revision;
    return this.cachedLines;
  }

  private allMessages(): ChatMessage[] {
    return this.live ? [...this.history, { role: 'assistant', content: this.live, timestamp: new Date(), markdown: false }] : this.history.slice();
  }

  private renderMessages(all: ChatMessage[], width: number): string[] {
    const p = getPalette();
    const lines: string[] = [];
    for (const [index, msg] of all.entries()) {
      if (index) lines.push('');
      const cached = this.messageCache.get(msg);
      if (cached?.width === width) { lines.push(...cached.lines); continue; }
      const begin = lines.length;
      const inner = Math.max(1, width - 2);
      const error = msg.tone === 'error';
      const colour = error ? p.error : msg.role === 'user' ? p.accent : p.dim;
      if (msg.role !== 'system') {
        lines.push(chalk.bold.hex(msg.role === 'user' ? p.accent : p.fg)(msg.role === 'user' ? 'You' : 'Octipus'));
      }
      const markdown = msg.role === 'assistant' && this.options.markdown !== false && msg.markdown !== false;
      const body = markdown
        ? new Markdown(msg.content, 0, 0, getMarkdownTheme()).render(inner)
        : wrapTextWithAnsi((error ? 'Error · ' : '') + msg.content, inner);
      for (const line of body) {
        const rail = msg.role === 'user' ? chalk.hex(p.accent)('│ ') : msg.role === 'system' ? chalk.hex(colour)(error ? '! ' : '· ') : '  ';
        lines.push(rail + (msg.role === 'system' ? chalk.hex(colour)(line) : msg.role === 'user' ? chalk.hex(p.fg)(line) : line));
      }
      this.messageCache.set(msg, { width, lines: lines.slice(begin) });
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
      this.frozenBlocks = this.frozenMessages.map((message, n) => (this.messageCache.get(message)?.lines.length ?? 0) + (n ? 1 : 0));
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
      : `PgUp/PgDn${this.mouseCaptured ? ' or wheel' : ''}: history · Ctrl+Home: oldest · ↑ ${start} rows`, width, '');
      out.push(' '.repeat(Math.max(0, width - visibleWidth(label))) + chalk.hex(getPalette().dim)(label));
    }
    return out;
  }
}
