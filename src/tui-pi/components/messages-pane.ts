/**
 * Scrolling chat pane.
 *
 * Renders the last N messages with role-aware formatting:
 *   - user / system → wrapped, role-coloured plain text
 *   - assistant     → pi-tui Markdown (headings, code fences, lists,
 *                     links, etc.) via a per-message cached Markdown
 *                     component
 *
 * Markdown rendering can be opted out per message (e.g. when streaming
 * partial chunks where the parser would mis-format incomplete syntax)
 * by passing `markdown: false` on push.
 */
import { type Component, Markdown, visibleWidth, wrapTextWithAnsi } from '@mariozechner/pi-tui';
import { colorFor, getMarkdownTheme } from '../theme/defaults';
import type { Role } from '../gateway-adapter';

export interface ChatMessage {
  role: Role;
  content: string;
  timestamp: Date;
  /** Disable markdown rendering for assistant messages (default: enabled). */
  markdown?: boolean;
}

export interface MessagesPaneOptions {
  /** Maximum visible messages (older messages are dropped from the rendered list, not from history). */
  maxVisible?: number;
  /** Toggle markdown rendering for assistant messages globally (default: true). */
  markdown?: boolean;
}

const ROLE_PREFIX: Record<Role, string> = {
  user:      '❯ ',
  assistant: '  ',
  system:    '· ',
};

interface RenderedMessage {
  role: Role;
  content: string;
  markdown?: Markdown;
}

export class MessagesPane implements Component {
  private readonly history: RenderedMessage[] = [];
  private readonly maxVisible: number;
  private readonly markdownEnabled: boolean;
  private cachedLines: string[] = [];
  private cachedWidth = -1;
  private dirty = true;
  /**
   * Number of messages above the bottom of history to skip when
   * rendering. 0 = pinned to bottom (live tail). Increased by
   * `scrollUp()`, decreased by `scrollDown()`. Auto-resets to 0 only
   * when a new message arrives while already pinned at the bottom —
   * if the user is reading history mid-scroll, new content stays out
   * of view until they `scrollToBottom()`.
   */
  private scrollOffset = 0;

  constructor(options: MessagesPaneOptions = {}) {
    this.maxVisible = options.maxVisible ?? 30;
    this.markdownEnabled = options.markdown ?? true;
  }

  push(message: ChatMessage): void {
    const markdownEnabled = this.markdownEnabled && (message.markdown ?? true);
    const useMarkdown = message.role === 'assistant' && markdownEnabled;
    this.history.push({
      role: message.role,
      content: message.content,
      markdown: useMarkdown ? new Markdown(message.content, 0, 0, getMarkdownTheme()) : undefined,
    });
    this.dirty = true;
  }

  reset(): void {
    this.history.length = 0;
    this.scrollOffset = 0;
    this.dirty = true;
    this.cachedLines = [];
  }

  /** Page-style scroll up. Returns true when the offset moved. */
  scrollUp(by: number = this.maxVisible): boolean {
    const max = Math.max(0, this.history.length - this.maxVisible);
    const next = Math.min(max, this.scrollOffset + by);
    if (next === this.scrollOffset) return false;
    this.scrollOffset = next;
    this.dirty = true;
    return true;
  }

  /** Page-style scroll down. Returns true when the offset moved. */
  scrollDown(by: number = this.maxVisible): boolean {
    const next = Math.max(0, this.scrollOffset - by);
    if (next === this.scrollOffset) return false;
    this.scrollOffset = next;
    this.dirty = true;
    return true;
  }

  scrollToBottom(): void {
    if (this.scrollOffset === 0) return;
    this.scrollOffset = 0;
    this.dirty = true;
  }

  getScrollOffset(): number {
    return this.scrollOffset;
  }

  invalidate(): void {
    this.dirty = true;
    this.cachedWidth = -1;
    for (const message of this.history) message.markdown?.invalidate();
  }

  render(width: number): string[] {
    if (!this.dirty && width === this.cachedWidth) return this.cachedLines;

    const total = this.history.length;
    // Window of `maxVisible` messages ending `scrollOffset` rows above the bottom.
    const end = Math.max(0, total - this.scrollOffset);
    const start = Math.max(0, end - this.maxVisible);
    const visible = this.history.slice(start, end);
    const lines: string[] = [];
    for (let i = 0; i < visible.length; i++) {
      const msg = visible[i];
      const prefix = ROLE_PREFIX[msg.role];
      const indent = ' '.repeat(visibleWidth(prefix));
      const innerWidth = Math.max(1, width - visibleWidth(prefix));

      if (msg.markdown) {
        const rendered = msg.markdown.render(innerWidth);
        for (let j = 0; j < rendered.length; j++) {
          lines.push((j === 0 ? prefix : indent) + rendered[j]);
        }
      } else {
        const color = colorFor(msg.role);
        const wrapped = wrapTextWithAnsi(msg.content, innerWidth);
        for (let j = 0; j < wrapped.length; j++) {
          lines.push(color((j === 0 ? prefix : indent) + wrapped[j]));
        }
      }

      if (i < visible.length - 1) lines.push('');
    }

    // Hint when scrolled away from the live tail.
    if (this.scrollOffset > 0) {
      const remaining = total - end;
      const hidden = this.scrollOffset;
      const hint = `↓ ${hidden} newer message${hidden === 1 ? '' : 's'}` +
        (remaining > 0 ? ` · ↑ ${remaining} older` : '');
      lines.push('');
      lines.push(colorFor('system')(hint));
    }

    this.cachedLines = lines;
    this.cachedWidth = width;
    this.dirty = false;
    return lines;
  }
}
