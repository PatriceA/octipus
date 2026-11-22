/**
 * Messages typed while a turn runs, shown in the sticky rows above the
 * composer until the turn ends and the first of them is sent.
 *
 * Each one can be taken back into the composer to edit or remove it before
 * it goes out: click its row, or the `app.queue.edit` key (the newest one).
 * The same rows carry a short hint ("Esc again clears the draft").
 */
import { type Component, displayLine, truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult } from '@/tui-kit';
import { chalk, getPalette } from '../theme/defaults';

export interface QueuedMessage<Extra = unknown> {
  text: string;
  /** What else travels with the message (its image attachments). */
  extra: Extra;
}

export class QueuedMessages<Extra = unknown> implements Component {
  private items: QueuedMessage<Extra>[] = [];
  private hint: string | null = null;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  /** A queued row was clicked. */
  onEdit?: (index: number) => void;
  /** The hint went away by itself; the screen should be redrawn. */
  onExpire?: () => void;
  /** The keys shown in the help row. */
  constructor(private readonly editKey: () => string = () => 'Alt+E') {}

  get size(): number { return this.items.length; }
  all(): readonly QueuedMessage<Extra>[] { return this.items; }
  push(item: QueuedMessage<Extra>): void { this.items.push(item); }
  /** The next message to send, removed from the queue. */
  shift(): QueuedMessage<Extra> | undefined { return this.items.shift(); }
  /** Remove and return one message (to edit it); the newest when no index is given. */
  take(index = this.items.length - 1): QueuedMessage<Extra> | undefined {
    if (index < 0 || index >= this.items.length) return undefined;
    return this.items.splice(index, 1)[0];
  }
  /** Remove and return every message, oldest first. */
  drain(): QueuedMessage<Extra>[] { const all = this.items; this.items = []; return all; }

  /** A one-line hint under the queue, gone after `ms` (or with the next hint). */
  setHint(text: string | null, ms = 1500): void {
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = null;
    this.hint = text;
    if (text === null) return;
    this.hintTimer = setTimeout(() => { this.hint = null; this.hintTimer = null; this.onExpire?.(); }, ms);
    this.hintTimer.unref?.();
  }
  getHint(): string | null { return this.hint; }
  dispose(): void { this.setHint(null); }

  render(width: number): string[] {
    const p = getPalette();
    const rows = this.items.map((item, index) => {
      const label = `⧗ queued ${index + 1} · `;
      return truncateToWidth(chalk.hex(p.accent)(label) + chalk.hex(p.fg)(displayLine(item.text)), width, '…');
    });
    if (this.items.length) {
      rows.push(truncateToWidth(chalk.hex(p.dim)(`  sent when the turn ends · ${this.editKey()} or click: edit or remove · Esc: stop the turn`), width, ''));
    }
    if (this.hint) rows.push(truncateToWidth(chalk.hex(p.warn)(this.hint), width, ''));
    return rows;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== 'left' || event.y >= this.items.length) return undefined;
    if (event.type === 'click') { this.onEdit?.(event.y); return { handled: true }; }
    return event.type === 'press' || event.type === 'release' ? { handled: true } : undefined;
  }

  invalidate(): void {}
}
