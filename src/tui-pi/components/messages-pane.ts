/** Shared, row-scrolled transcript for the chat shell and editor. */
import { type Component, Markdown, truncateToWidth, wrapTextWithAnsi } from '@mariozechner/pi-tui';
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
  private newer = 0;
  private messageCache = new WeakMap<ChatMessage, { width: number; lines: string[] }>();

  constructor(private readonly options: MessagesPaneOptions = {}) {
    this.height = options.maxVisible ?? 30;
  }
  setHeight(rows: number): void { this.height = Math.max(0, rows); }
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
    this.frozen = null; this.newer = 0; this.revision++;
  }
  scrollUp(by = Math.max(1, this.height - 2)): boolean {
    const lines = this.frozen ?? this.lines(this.width);
    const next = Math.min(Math.max(0, lines.length - Math.max(1, this.height - 1)), this.offset + by);
    if (next === this.offset) return false;
    this.frozen ??= lines.slice();
    this.offset = next;
    return true;
  }
  scrollDown(by = Math.max(1, this.height - 2)): boolean {
    if (!this.offset) return false;
    this.offset = Math.max(0, this.offset - by);
    if (!this.offset) this.scrollToBottom();
    return true;
  }
  scrollToBottom(): void { this.offset = 0; this.frozen = null; this.newer = 0; }
  getScrollOffset(): number { return this.offset; }
  invalidate(): void { this.messageCache = new WeakMap(); this.revision++; }

  private lines(width: number): string[] {
    if (width === this.cachedWidth && this.revision === this.cachedRevision) return this.cachedLines;
    const p = getPalette();
    const lines: string[] = [];
    const all = this.live ? [...this.history, { role: 'assistant' as const, content: this.live, timestamp: new Date(), markdown: false }] : this.history;
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
    this.cachedWidth = width; this.cachedRevision = this.revision;
    return this.cachedLines = lines;
  }

  render(width: number): string[] {
    this.width = Math.max(1, width);
    if (this.height === 0 || width <= 0) return [];
    // Freeze the rows being read. Incoming messages and streaming cannot move
    // the reading position; a resize clips these rows until returning to live.
    const lines = this.frozen ?? this.lines(width);
    const hint = this.offset > 0;
    const budget = Math.max(0, this.height - (hint ? 1 : 0));
    const end = Math.max(0, lines.length - this.offset);
    const start = Math.max(0, end - budget);
    const out = lines.slice(start, end).map(line => truncateToWidth(line, width, ''));
    if (hint) out.push(truncateToWidth(chalk.hex(getPalette().dim)(`↑ ${start} rows · ↓ ${this.offset} rows${this.newer ? ` · ${this.newer} new` : ''} · End: latest`), width, ''));
    return out;
  }
}
