import { renderChatFrame } from '@/tui-pi/components/chat-frame';
import { SubagentPanel } from '@/tui-pi/components/subagent-panel';
/**
 * Chat pane shown on the right of the editor.
 *
 * Stacks the messages history (tui-pi MessagesPane) on top of an
 * activity line on top of a slim composer. Messages stay anchored
 * to the top of the pane, the composer stays anchored to the bottom,
 * and any leftover rows pad the gap between them — matching the
 * chat-shell layout.
 *
 * The pane only handles input when the layout focuses it; the
 * SplitPane's input router enforces that.
 *
 * The mouse: the wheel scrolls the transcript, a click focuses the pane,
 * and a drag selects text inside the pane only — the screen's own selection
 * would run across the tree and the editor beside it — and copies it on
 * release, without the transcript's rail.
 */
import { type Component, sliceByColumn, stripTerminalSequences, type TUI, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth } from '@/tui-kit';
import { ActivityLine } from '@/tui-pi/components/activity-line';
import { Composer } from '@/tui-pi/components/composer';
import { MessagesPane, stripTranscriptRails } from '@/tui-pi/components/messages-pane';

export interface ChatPaneOptions {
  tui: TUI;
  basePath: string;
  onSubmit: (text: string) => void;
  /** The pane was clicked: give it the focus. */
  onFocus?: () => void;
  /** A drag selected this text. */
  onCopy?: (text: string) => void;
}

interface Cell { row: number; col: number }

export class ChatPane implements Component {
  readonly subagents = new SubagentPanel();
  readonly messages: MessagesPane;
  readonly activity: ActivityLine;
  readonly composer: Composer;
  private height: number | null = null;
  private lines: string[] = [];
  private selection: { anchor: Cell; focus: Cell } | null = null;
  private dragging = false;

  constructor(private readonly options: ChatPaneOptions) {
    this.messages = new MessagesPane({ maxVisible: 50 });
    this.activity = new ActivityLine(options.tui);
    this.composer = new Composer(options.tui, { basePath: options.basePath });
    this.composer.onSubmit = options.onSubmit;
  }

  invalidate(): void {
    for (const part of [this.messages, this.activity, this.composer, this.subagents]) part.invalidate();
  }

  setHeight(rows: number): void {
    this.height = Math.max(0, rows);
  }

  render(width: number): string[] {
    this.lines = renderChatFrame(width, this.height ?? 24, this);
    const range = this.range();
    if (!range) return this.lines;
    return this.lines.map((line, row) => {
      const cols = this.columnsOn(row, range, line);
      if (!cols) return line;
      const before = sliceByColumn(line, 0, cols.start, true);
      const inside = stripTerminalSequences(sliceByColumn(line, cols.start, cols.end - cols.start, true));
      const after = sliceByColumn(line, cols.end, Math.max(0, width - cols.end), true);
      return `${before}\x1b[7m${inside}\x1b[27m${after}`;
    });
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === 'wheel') {
      if (event.wheelDelta && event.wheelDelta < 0) this.messages.scrollUp(-event.wheelDelta);
      else if (event.wheelDelta) this.messages.scrollDown(event.wheelDelta);
      this.selection = null;
      return { handled: true };
    }
    if (event.button !== 'left' && event.type !== 'release') return { handled: true };
    const at = { row: Math.max(0, Math.min(this.lines.length - 1, event.y)), col: Math.max(0, event.x) };
    if (event.type === 'press') {
      this.options.onFocus?.();
      this.selection = { anchor: at, focus: at };
      this.dragging = true;
      return { capture: true };
    }
    if (event.type === 'drag' && this.dragging && this.selection) {
      this.selection.focus = at;
      return { handled: true };
    }
    if (event.type === 'release' && this.dragging) {
      this.dragging = false;
      const text = this.selectedText();
      if (text) this.options.onCopy?.(text);
      else this.selection = null;
      return { handled: true, render: true };
    }
    return { handled: true };
  }

  /** The selected text, as drawn in the pane, without the rail and trailing spaces. */
  selectedText(): string {
    const range = this.range();
    if (!range) return '';
    const out: string[] = [];
    for (let row = range.start.row; row <= range.end.row; row++) {
      const line = this.lines[row] ?? '';
      const cols = this.columnsOn(row, range, line);
      out.push(cols ? stripTerminalSequences(sliceByColumn(line, cols.start, cols.end - cols.start, true)).trimEnd() : '');
    }
    return stripTranscriptRails(out.join('\n')).trim() ? stripTranscriptRails(out.join('\n')) : '';
  }

  private range(): { start: Cell; end: Cell } | null {
    const s = this.selection;
    if (!s || (s.anchor.row === s.focus.row && s.anchor.col === s.focus.col)) return null;
    const forward = s.anchor.row < s.focus.row || (s.anchor.row === s.focus.row && s.anchor.col <= s.focus.col);
    return forward ? { start: s.anchor, end: s.focus } : { start: s.focus, end: s.anchor };
  }

  private columnsOn(row: number, range: { start: Cell; end: Cell }, line: string): { start: number; end: number } | null {
    if (row < range.start.row || row > range.end.row) return null;
    const width = visibleWidth(line);
    const start = row === range.start.row ? range.start.col : 0;
    const end = row === range.end.row ? Math.min(width, range.end.col + 1) : width;
    return end > start ? { start, end } : null;
  }
}
