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
    this.dirty = true;
    this.cachedLines = [];
  }

  invalidate(): void {
    this.dirty = true;
    this.cachedWidth = -1;
    for (const message of this.history) message.markdown?.invalidate();
  }

  render(width: number): string[] {
    if (!this.dirty && width === this.cachedWidth) return this.cachedLines;

    const visible = this.history.slice(-this.maxVisible);
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

    this.cachedLines = lines;
    this.cachedWidth = width;
    this.dirty = false;
    return lines;
  }
}
