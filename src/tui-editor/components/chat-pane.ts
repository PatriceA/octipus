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
 */
import { type Component, Container, type TUI } from '@mariozechner/pi-tui';
import { ActivityLine } from '@/tui-pi/components/activity-line';
import { Composer } from '@/tui-pi/components/composer';
import { MessagesPane } from '@/tui-pi/components/messages-pane';

export interface ChatPaneOptions {
  tui: TUI;
  basePath: string;
  onSubmit: (text: string) => void;
}

export class ChatPane extends Container implements Component {
  readonly subagents = new SubagentPanel();
  readonly messages: MessagesPane;
  readonly activity: ActivityLine;
  readonly composer: Composer;
  private height: number | null = null;

  constructor(options: ChatPaneOptions) {
    super();
    this.messages = new MessagesPane({ maxVisible: 50 });
    this.activity = new ActivityLine(options.tui);
    this.composer = new Composer(options.tui, { basePath: options.basePath });
    this.composer.onSubmit = options.onSubmit;

    this.addChild(this.messages);
    this.addChild(this.activity);
    this.addChild(this.composer);
  }

  setHeight(rows: number): void {
    this.height = Math.max(0, rows);
  }

  override render(width: number): string[] {
    return renderChatFrame(width, this.height ?? 24, this);
  }
}
