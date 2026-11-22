/**
 * Three-pane horizontal layout: optional file tree on the left,
 * always-on editor in the center, optional chat pane on the right.
 *
 * Width allocation is read from the LayoutStore on every render so
 * the panes resize when the user toggles them, or drags a divider
 * (`treeWidth` / `chatWidth`). Each pane can be a Container holding
 * multiple stacked sub-components — this layer is agnostic to what
 * lives inside.
 *
 * Input routing dispatches to the focused pane based on
 * `LayoutStore.focused`. Pi-tui's overlay/focus stack still owns
 * keystrokes whenever a modal is open, so this routing only fires
 * for the regular composer/editor/tree input loop.
 *
 * The mouse goes to the pane under the pointer, whatever has the focus: a
 * wheel scrolls that pane, a click on a pane's title focuses it, and a press
 * on a divider drags it. A pane that takes a press (`capture`) gets the drag
 * and the release that follow, in its own coordinates, even outside it.
 */
import { type Component, getKeybindings, truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth } from '@/tui-kit';
import type { LayoutStore, PaneId } from '../stores/layout-store';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

const TREE_WIDTH = 30;
/** Narrowest a dragged pane may be. */
const MIN_SIDE = 12;
const MIN_EDITOR = 20;

export interface SplitPaneOptions {
  layout: LayoutStore;
  tree: Component;
  editor: Component;
  chat: Component;
  /** Hooks called with the assigned width per pane on every render — used to size sub-content (e.g. editor viewport). */
  onResize?: (sizes: { tree: number; editor: number; chat: number; rows: number }) => void;
}

interface Columns { compact: boolean; tree: number; editor: number; chat: number }
type Target = { kind: 'pane'; pane: PaneId; x: number; width: number } | { kind: 'divider'; pane: 'tree' | 'chat' };

export class SplitPane implements Component {
  private readonly options: SplitPaneOptions;
  private columns: Columns = { compact: false, tree: 0, editor: 0, chat: 0 };
  private width = 0;
  /** The pane or divider a press went to: it gets the drag, release and click that follow. */
  private captured: Target | null = null;

  constructor(options: SplitPaneOptions) {
    this.options = options;
  }

  /** The columns each pane takes at `width`. */
  private layoutColumns(width: number): Columns {
    const state = this.options.layout.get();
    // On small terminals show the focused pane at full width. Switching
    // focus switches the visible surface too, so input never goes offscreen.
    const compact = width < 80;
    if (compact) {
      return { compact, tree: state.focused === 'tree' ? width : 0, editor: state.focused === 'editor' ? width : 0, chat: state.focused === 'chat' ? width : 0 };
    }
    const defaultTree = Math.min(TREE_WIDTH, Math.floor(width / 4));
    const defaultChat = Math.max(30, Math.floor(width * 0.32));
    let tree = state.treeVisible ? state.treeWidth ?? defaultTree : 0;
    let chat = state.chatVisible ? state.chatWidth ?? defaultChat : 0;
    // A dragged width gives way when the terminal shrinks: the editor keeps room.
    const room = (side: number) => Math.max(MIN_SIDE, side);
    if (tree) tree = Math.min(room(tree), Math.max(MIN_SIDE, width - (chat ? chat + 1 : 0) - 1 - MIN_EDITOR));
    if (chat) chat = Math.min(room(chat), Math.max(MIN_SIDE, width - (tree ? tree + 1 : 0) - 1 - MIN_EDITOR));
    const editor = Math.max(0, width - tree - chat - (tree ? 1 : 0) - (chat ? 1 : 0));
    return { compact, tree, editor, chat };
  }

  render(width: number): string[] {
    const palette = getPalette();
    const state = this.options.layout.get();
    const cols = this.layoutColumns(width);
    this.columns = cols;
    this.width = width;
    const { compact, tree: treeW, editor: editorW, chat: chatW } = cols;
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

  /** What is at column `x`: a pane (with where it starts) or a divider. */
  private targetAt(x: number): Target | null {
    const { tree, editor, chat } = this.columns;
    let at = 0;
    const panes: Array<[PaneId, number]> = [['tree', tree], ['editor', editor], ['chat', chat]];
    const shown = panes.filter(([, w]) => w > 0);
    for (let i = 0; i < shown.length; i++) {
      const [pane, w] = shown[i];
      if (x >= at && x < at + w) return { kind: 'pane', pane, x: at, width: w };
      at += w;
      if (i < shown.length - 1) {
        // The divider after a pane belongs to the side pane next to it.
        if (x === at) return { kind: 'divider', pane: pane === 'tree' ? 'tree' : 'chat' };
        at += 1;
      }
    }
    return null;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // A new gesture: whatever the last press captured is done (a drag is followed by no click).
    if (event.type === 'press' || event.type === 'move' || event.type === 'wheel') this.captured = null;
    const captured = this.captured;
    if (captured && (event.type === 'drag' || event.type === 'release' || event.type === 'click')) {
      if (event.type === 'click') this.captured = null;
      if (captured.kind === 'divider') {
        if (event.type === 'drag') this.dragDivider(captured.pane, event.x);
        return { handled: true };
      }
      return { ...(this.forward(captured, event) ?? {}), handled: true };
    }
    const target = this.targetAt(event.x);
    if (!target) return { handled: true };
    if (target.kind === 'divider') {
      if (event.type === 'press' && event.button === 'left') { this.captured = target; return { capture: true }; }
      return { handled: true };
    }
    // The title row: a click there focuses the pane.
    if (event.y === 0) {
      if (event.type === 'press') this.options.layout.focus(target.pane);
      return { handled: true };
    }
    const result = this.forward(target, event);
    if (event.type === 'press') {
      this.captured = target;
      return { ...(result ?? {}), capture: true };
    }
    return result ?? (event.type === 'wheel' ? { handled: true } : undefined);
  }

  private forward(target: Extract<Target, { kind: 'pane' }>, event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const pane = target.pane === 'tree' ? this.options.tree : target.pane === 'chat' ? this.options.chat : this.options.editor;
    const result = pane.handleMouse?.({ ...event, x: event.x - target.x, y: event.y - 1, width: target.width, height: Math.max(0, event.height - 1) });
    // A pane's own dispatch target names a component inside it; the split pane keeps the gesture.
    if (!result) return undefined;
    const { handled, capture, render } = result;
    return { handled, capture, render };
  }

  private dragDivider(pane: 'tree' | 'chat', x: number): void {
    const width = this.width;
    if (pane === 'tree') {
      const max = width - (this.columns.chat ? this.columns.chat + 1 : 0) - 1 - MIN_EDITOR;
      this.options.layout.setPaneWidth('tree', Math.max(MIN_SIDE, Math.min(max, x)));
    } else {
      const max = width - (this.columns.tree ? this.columns.tree + 1 : 0) - 1 - MIN_EDITOR;
      this.options.layout.setPaneWidth('chat', Math.max(MIN_SIDE, Math.min(max, width - x - 1)));
    }
  }

  handleInput(data: string): void {
    const focused: PaneId = this.options.layout.get().focused;
    const target = focused === 'tree' ? this.options.tree
                 : focused === 'chat' ? this.options.chat
                 :                       this.options.editor;
    target.handleInput?.(data);
  }

  invalidate(): void {
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
