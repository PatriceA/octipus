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
 * While the transcript search is open (`showAll`) every item in memory is
 * rendered: the search reads the rendered rows, and a message outside the
 * window was neither found nor counted.

 */
import { type Component, ScrollView, type TuiMouseEvent, type TuiMouseEventResult } from '@/tui-kit';
import type { MessagesPane } from './messages-pane';

export class TranscriptScroll extends ScrollView {
  /** Rows added above the current position since the last layout. */
  pendingShift = 0;
  /**
   * Ask for a frame that renders the document again (the app's
   * `tui.requestRender`). A scroll alone redraws from the last frame's rows
   * without rendering the document, so the window would not grow until
   * something else changed.
   */
  requestContent: () => void = () => {};

  constructor(readonly document: TranscriptDocument) {
    super(document, { follow: 'end', primary: true, overscroll: 'chain', scrollbar: 'auto' });
    document.attach(this);
  }

  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    if (this.pendingShift) {
      const shift = this.pendingShift;
      this.pendingShift = 0;
      this.scrollTo(this.scrollTop + shift);
    }
    this.document.laidOut(this);
  }
}

export class TranscriptDocument implements Component {
  private scroll: TranscriptScroll | null = null;
  /** Render everything in memory, not just the window (the search is open). */
  showAll: () => boolean = () => false;

  constructor(readonly pane: MessagesPane) {}

  attach(scroll: TranscriptScroll): void {
    this.scroll = scroll;
    this.pane.readingLatest = () => scroll.isFollowingEnd;
  }

  /** After every layout, scroll-only frames included: near the top of the window, render again so older items come in. */
  laidOut(scroll: TranscriptScroll): void {
    if (scroll.viewportHeight <= 0 || this.showAll() || scroll.isFollowingEnd) return;
    if (scroll.scrollTop < scroll.viewportHeight && this.pane.canGrow()) scroll.requestContent();
  }

  render(width: number): string[] {
    const scroll = this.scroll;
    if (this.showAll()) {
      if (this.pane.canGrow()) {
        const before = this.pane.documentLines(width).length;
        this.pane.growAll();
        if (scroll && !scroll.isFollowingEnd) scroll.pendingShift += this.pane.documentLines(width).length - before;
      }
      return this.pane.documentLines(width);
    }
    if (scroll && !scroll.isFollowingEnd && scroll.viewportHeight > 0 && scroll.scrollTop < scroll.viewportHeight && this.pane.canGrow()) {
      const before = this.pane.documentLines(width).length;
      this.pane.growWindow();
      scroll.pendingShift += this.pane.documentLines(width).length - before;
    } else if (scroll?.isFollowingEnd) {
      this.pane.trimWindow();
    }
    return this.pane.documentLines(width);
  }

  /**
   * A click on a tool group's or a thinking item's summary row folds or
   * unfolds it. Only those rows take the press; anywhere else a drag still
   * selects text.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== 'left') return undefined;
    const item = this.pane.foldableAt(event.y);
    if (!item) return undefined;
    if (event.type === 'click') { this.pane.toggle(item); return { handled: true }; }
    return event.type === 'press' || event.type === 'release' ? { handled: true } : undefined;
  }

  invalidate(): void { this.pane.invalidate(); }
}

export function createTranscriptView(pane: MessagesPane): TranscriptScroll {
  return new TranscriptScroll(new TranscriptDocument(pane));
}
