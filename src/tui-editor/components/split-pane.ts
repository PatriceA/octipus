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
import { Container, type Component, getKeybindings, truncateToWidth, visibleWidth } from '@mariozechner/pi-tui';
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

    // On small terminals show the focused pane at full width. Switching
    // focus switches the visible surface too, so input never goes offscreen.
    const compact = width < 80;
    const treeW = compact ? (state.focused === 'tree' ? width : 0) : state.treeVisible ? Math.min(TREE_WIDTH, Math.floor(width / 4)) : 0;
    const chatW = compact ? (state.focused === 'chat' ? width : 0) : state.chatVisible ? Math.max(30, Math.floor(width * 0.32)) : 0;
    const editorW = compact ? (state.focused === 'editor' ? width : 0) : Math.max(0, width - treeW - chatW - (treeW ? 1 : 0) - (chatW ? 1 : 0));
    this.options.onResize?.({ tree: treeW, editor: editorW, chat: chatW, rows: Math.max(0, state.rows - 2) });
    const editorLines = editorW > 0 ? this.options.editor.render(editorW) : [];
    const treeLines = treeW > 0 ? this.options.tree.render(treeW) : [];
    const chatLines = chatW > 0 ? this.options.chat.render(chatW) : [];

    const rows = Math.max(editorLines.length, treeLines.length, chatLines.length);
    // The hint follows the user's own binding, not the shipped default.
    const cycleKey = compact ? String(getKeybindings().getKeys('app.pane.cycle')[0] ?? 'ctrl+\\') : '';
    const title = (name: string, id: PaneId, w: number) => fitTo(chalk.hex(state.focused === id ? palette.accent : palette.dim)(`${state.focused === id ? '▸' : ' '} ${name}${compact ? ` · ${cycleKey} switch pane` : ''}`), w);
    const headers = [treeW ? title('Files', 'tree', treeW) : null, editorW ? title('Editor', 'editor', editorW) : null, chatW ? title('Chat', 'chat', chatW) : null].filter((v): v is string => v !== null);
    const out: string[] = [headers.join(chalk.hex(palette.border)('│'))];
    const divider = chalk.hex(palette.border)('│');
    for (let i = 0; i < rows; i++) {
      let line = '';
      if (treeW > 0) {
        line += fitTo(treeLines[i] ?? '', treeW) + (editorW || chatW ? divider : '');
      }
      if (editorW) line += fitTo(editorLines[i] ?? '', editorW);
      if (chatW > 0) {
        line += (editorW ? divider : '') + fitTo(chatLines[i] ?? '', chatW);
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
