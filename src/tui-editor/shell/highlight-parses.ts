/**
 * Debounced re-parse for highlighting: a buffer whose text changed is
 * parsed again 150 ms after the last edit; one that closed is forgotten.
 * Every buffer has its own parse, so two files of a language do not evict
 * each other.
 */
import { dropSource, setSource } from '../editor/highlight-tree-sitter';
import type { BufferRecord, BufferStore } from '../stores/buffer-store';

export class HighlightParses {
  /** Debounced re-parse per buffer, and the text version each last parsed. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly parsedVersion = new Map<string, number>();

  constructor(private readonly buffers: BufferStore, private readonly requestRender: () => void) {}

  schedule(buffers: readonly BufferRecord[]): void {
    const open = new Set(buffers.map((b) => b.id));
    for (const id of [...this.parsedVersion.keys()]) {
      if (open.has(id)) continue;
      this.parsedVersion.delete(id);
      const timer = this.timers.get(id);
      if (timer) clearTimeout(timer);
      this.timers.delete(id);
      dropSource(id);
    }
    for (const rec of buffers) {
      if (this.parsedVersion.get(rec.id) === rec.buffer.textVersion) continue;
      const first = !this.parsedVersion.has(rec.id);
      this.parsedVersion.set(rec.id, rec.buffer.textVersion);
      const existing = this.timers.get(rec.id);
      if (existing) clearTimeout(existing);
      const parse = () => {
        this.timers.delete(rec.id);
        const current = this.buffers.byId(rec.id);
        if (current) void setSource(current.id, current.language, current.buffer.text()).then(() => this.requestRender());
      };
      // A newly opened buffer is parsed at once; edits wait for a pause.
      if (first) parse();
      else {
        const timer = setTimeout(parse, 150);
        timer.unref?.();
        this.timers.set(rec.id, timer);
      }
    }
  }

  /** Parse buffer `id` again now, as if newly opened (its language may have changed). */
  reparse(id: string): void {
    this.parsedVersion.delete(id);
    this.schedule(this.buffers.get().buffers);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const id of this.parsedVersion.keys()) dropSource(id);
    this.parsedVersion.clear();
  }
}
