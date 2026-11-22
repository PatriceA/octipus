/**
 * Questions that something in the background wants to ask: a file changed
 * on disk under unsaved edits, an agent edit ready for review.
 *
 * They are never opened on their own. A prompt that pops up while the user
 * types takes the keyboard mid-word, and its single-letter answers (`r`
 * reload, `o` overwrite, `a` accept all, `r` reject all) turn the next
 * keystrokes into a decision nobody made. Instead each waits here, the mode
 * bar says so until it is resolved, and it opens when the user presses the
 * resolve key (`app.pending.open`) or tries to save the buffer it is about.
 *
 * A prompt the user opened themselves (Ctrl+S on a file that changed) is
 * not one of these: it opens at once, as before.
 */
import { getKeybindings } from '@/tui-kit';

export interface PendingPrompt {
  /** One per kind and buffer: adding a prompt with the same key replaces it. */
  key: string;
  bufferId: string;
  /** What is waiting, for the mode bar: "a.ts changed on disk". */
  text: string;
  /** Open the prompt. Called once; the prompt is no longer pending. */
  open: () => void;
}

export class PendingPrompts {
  private items: PendingPrompt[] = [];
  private readonly listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void { for (const fn of this.listeners) fn(); }

  add(prompt: PendingPrompt): void {
    this.items = [...this.items.filter((p) => p.key !== prompt.key), prompt];
    this.changed();
  }

  remove(key: string): void {
    const before = this.items.length;
    this.items = this.items.filter((p) => p.key !== key);
    if (this.items.length !== before) this.changed();
  }

  has(key: string): boolean { return this.items.some((p) => p.key === key); }

  list(): readonly PendingPrompt[] { return this.items; }

  /** Drop the prompts of buffers that are gone. */
  prune(isOpen: (bufferId: string) => boolean): void {
    const kept = this.items.filter((p) => isOpen(p.bufferId));
    if (kept.length === this.items.length) return;
    this.items = kept;
    this.changed();
  }

  /** Open the oldest prompt; false when nothing is waiting. */
  openNext(): boolean {
    const next = this.items[0];
    if (!next) return false;
    this.take(next);
    return true;
  }

  /** Open the oldest prompt about `bufferId` (saving that buffer); false when none is waiting. */
  openFor(bufferId: string): boolean {
    const next = this.items.find((p) => p.bufferId === bufferId);
    if (!next) return false;
    this.take(next);
    return true;
  }

  private take(prompt: PendingPrompt): void {
    this.items = this.items.filter((p) => p !== prompt);
    this.changed();
    prompt.open();
  }

  /** The mode bar's line: the oldest prompt, the key that opens it, and how many more wait. */
  summary(): string | null {
    const first = this.items[0];
    if (!first) return null;
    const key = getKeybindings().getKeys('app.pending.open')[0] ?? 'the resolve key';
    const more = this.items.length > 1 ? ` (+${this.items.length - 1} more)` : '';
    return `${first.text} — press ${key} to resolve${more}`;
  }
}

/** The pending prompt of a buffer whose file changed on disk under unsaved edits. */
export function externalKey(bufferId: string): string { return `external:${bufferId}`; }

/** The pending review of an agent edit to a buffer. */
export function reviewKey(bufferId: string): string { return `review:${bufferId}`; }
