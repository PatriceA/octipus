/**
 * Three-pane horizontal layout: optional file tree on the left,
 * always-on editor in the center, optional chat pane on the right.
 *
 * Width allocation is read from the LayoutStore on every render so
 * the panes resize when the user toggles them. Each pane can be a
 * Container holding multiple stacked sub-components — this layer is
 * agnostic to what lives inside.
 *
 * Input routing dispatches to the focused pane based on
 * `LayoutStore.focused`. Pi-tui's overlay/focus stack still owns
 * keystrokes whenever a modal is open, so this routing only fires
 * for the regular composer/editor/tree input loop.
 */
import { Container, type Component, truncateToWidth, visibleWidth } from '@mariozechner/pi-tui';
import type { LayoutStore, PaneId } from '../stores/layout-store';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

const TREE_WIDTH = 30;

export interface SplitPaneOptions {
  layout: LayoutStore;
  tree: Component;
  editor: Component;
  chat: Component;
  /** Hooks called with the assigned width per pane on every render — used to size sub-content (e.g. editor viewport). */
  onResize?: (sizes: { tree: number; editor: number; chat: number; rows: number }) => void;
}

export class SplitPane extends Container {
  private readonly options: SplitPaneOptions;

  constructor(options: SplitPaneOptions) {
    super();
    this.options = options;
  }

  override render(width: number): string[] {
    const palette = getPalette();
    const state = this.options.layout.get();

    let treeW = state.treeVisible ? Math.min(TREE_WIDTH, Math.floor(width / 4)) : 0;
    let chatW = state.chatVisible ? Math.max(30, Math.floor(width * 0.32)) : 0;
    let dividers = (treeW > 0 ? 1 : 0) + (chatW > 0 ? 1 : 0);
    // Drop chat first if the editor would shrink below its minimum viable width.
    if (width - treeW - chatW - dividers < 20 && chatW > 0) {
      chatW = 0;
      dividers = treeW > 0 ? 1 : 0;
    }
    if (width - treeW - chatW - dividers < 20 && treeW > 0) {
      treeW = 0;
      dividers = 0;
    }
    const editorW = Math.max(0, width - treeW - chatW - dividers);

    const editorLines = this.options.editor.render(editorW);
    // Notify before rendering tree/chat so they can size to the editor's row count.
    this.options.onResize?.({ tree: treeW, editor: editorW, chat: chatW, rows: editorLines.length });
    const treeLines = treeW > 0 ? this.options.tree.render(treeW) : [];
    const chatLines = chatW > 0 ? this.options.chat.render(chatW) : [];

    const rows = Math.max(editorLines.length, treeLines.length, chatLines.length);
    const out: string[] = [];
    const divider = chalk.hex(palette.border)('│');
    for (let i = 0; i < rows; i++) {
      let line = '';
      if (treeW > 0) {
        line += fitTo(treeLines[i] ?? '', treeW) + divider;
      }
      line += fitTo(editorLines[i] ?? '', editorW);
      if (chatW > 0) {
        line += divider + fitTo(chatLines[i] ?? '', chatW);
      }
      out.push(line);
    }
    return out;
  }

  handleInput(data: string): void {
    const focused: PaneId = this.options.layout.get().focused;
    const target = focused === 'tree' ? this.options.tree
                 : focused === 'chat' ? this.options.chat
                 :                       this.options.editor;
    target.handleInput?.(data);
  }

  override invalidate(): void {
    this.options.tree.invalidate();
    this.options.editor.invalidate();
    this.options.chat.invalidate();
  }
}

function fitTo(line: string, width: number): string {
  // pi-tui contract: components return lines ≤ width, but we defend against
  // misbehaving children (and incidental ANSI overhead) to keep the renderer
  // happy. Truncate first, then pad short lines to exact column width.
  // `visibleWidth` knows about CSI, OSC (e.g. hyperlinks), and wide chars,
  // so panes with markdown hyperlinks pad to the same column count as plain
  // text — otherwise a heading line would shrink the right divider in.
  const truncated = truncateToWidth(line, width, '');
  const visible = visibleWidth(truncated);
  if (visible >= width) return truncated;
  return truncated + ' '.repeat(width - visible);
}
