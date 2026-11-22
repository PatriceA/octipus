/**
 * The chat transcript on the alternate screen: a pi-tui `ScrollView` over the
 * rows of `MessagesPane`'s rendered window.
 *
 * The scroll view owns scrolling (wheel under the pointer, PageUp/PageDown,
 * Ctrl+Home/End), follows the end while the latest is shown and keeps a
 * reading position while replies stream in. It also owns drag selection,
 * including selection past the visible rows.
 *
 * The pane renders only a window of the newest items. Near the top of that
 * window this view lets older items in and moves the scroll position down by
 * the rows they added, in the same frame, so what is on screen stays put.
 */
import { type Component, ScrollView } from '@/tui-kit';
import type { MessagesPane } from './messages-pane';

export class TranscriptScroll extends ScrollView {
  /** Rows added above the current position since the last layout. */
  pendingShift = 0;

  constructor(readonly document: TranscriptDocument) {
    super(document, { follow: 'end', primary: true, overscroll: 'chain', scrollbar: 'auto' });
    document.attach(this);
  }

  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    if (!this.pendingShift) return;
    const shift = this.pendingShift;
    this.pendingShift = 0;
    this.scrollTo(this.scrollTop + shift);
  }
}

export class TranscriptDocument implements Component {
  private scroll: TranscriptScroll | null = null;

  constructor(readonly pane: MessagesPane) {}

  attach(scroll: TranscriptScroll): void {
    this.scroll = scroll;
    this.pane.readingLatest = () => scroll.isFollowingEnd;
  }

  render(width: number): string[] {
    const scroll = this.scroll;
    if (scroll && !scroll.isFollowingEnd && scroll.viewportHeight > 0 && scroll.scrollTop < scroll.viewportHeight && this.pane.canGrow()) {
      const before = this.pane.documentLines(width).length;
      this.pane.growWindow();
      scroll.pendingShift += this.pane.documentLines(width).length - before;
    } else if (scroll?.isFollowingEnd) {
      this.pane.trimWindow();
    }
    return this.pane.documentLines(width);
  }

  invalidate(): void { this.pane.invalidate(); }
}

export function createTranscriptView(pane: MessagesPane): TranscriptScroll {
  return new TranscriptScroll(new TranscriptDocument(pane));
}
