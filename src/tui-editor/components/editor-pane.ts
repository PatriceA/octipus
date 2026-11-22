/**
 * The middle pane: the tab strip on its first row, the text editor below.
 *
 * The mouse goes to the tab strip on the first row and to the editor below
 * it, in the editor's own coordinates; a press the editor takes keeps the
 * drag and release that follow, so a selection dragged over the tab strip or
 * past the bottom keeps selecting (and scrolls).
 */
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '@/tui-kit';
import type { TabStrip } from './tab-strip';
import type { TextEditor } from './text-editor';

export class EditorPane implements Component {
  /** Whether the press of the gesture in progress went to the editor. */
  private toEditor = false;

  constructor(private readonly tabs: TabStrip, private readonly editor: TextEditor) {}

  render(width: number): string[] {
    return [...this.tabs.render(width), ...this.editor.render(width)];
  }

  handleInput(data: string): void { this.editor.handleInput(data); }

  invalidate(): void { this.tabs.invalidate(); this.editor.invalidate(); }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === 'press' || event.type === 'wheel' || event.type === 'move') this.toEditor = event.y >= 1;
    if (this.toEditor) return this.editor.handleMouse({ ...event, y: event.y - 1, height: Math.max(0, event.height - 1) });
    return this.tabs.handleMouse(event);
  }
}
