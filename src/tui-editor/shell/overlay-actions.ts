/**
 * Opening the editor's app-level overlays: the command palette, the
 * shortcuts, the file picker, find and replace, the workspace picker and the
 * MCP list. Only one of these is open at a time; opening one hides the
 * others (pi-tui restores focus to whatever is underneath when an overlay
 * hides, but `refocus()` jumps straight back to the pane, so a stranded
 * overlay underneath would never get its focus back).
 */
import type { OverlayOptions } from '@/tui-kit';
import { FilePicker } from '../components/file-picker';
import { FindOverlay } from '../components/find-overlay';
import { HotkeysOverlay } from '../components/hotkeys-overlay';
import { ProjectSearchOverlay } from '../components/project-search-overlay';
import { MCPServerList, bridgeProvider } from '../components/mcp-server-list';
import { ReplaceOverlay } from '../components/replace-overlay';
import type { TextEditor } from '../components/text-editor';
import { WorkspacePicker } from '../components/workspace-picker';
import type { WorkspaceMeta, WorkspaceStore } from '../stores/workspace-store';
import type { ApiClient } from '../api-client';
import type { GatewayAdapter } from '@/tui-pi/gateway-adapter';
import type { EditorContext } from './context';
import { APP_OVERLAYS } from './overlay-slots';

/** Find and replace sit in the top-right corner, so the matches they draw in the buffer stay visible. */
export const SEARCH_OVERLAY: OverlayOptions = { anchor: 'top-right', width: 64, maxHeight: '85%', margin: { top: 2, right: 1 } };

/** Project search takes most of the screen: the list and the preview need the room. */
export const PROJECT_SEARCH_OVERLAY: OverlayOptions = { anchor: 'center', width: '90%', minWidth: 40, maxHeight: '90%', margin: 1 };

export interface EditorOverlayDeps {
  editor: TextEditor;
  workspace: WorkspaceStore;
  adapter: GatewayAdapter;
  apiClient: ApiClient;
  openFile: (path: string) => void;
  /** Run a palette command as if it had been typed in the composer. */
  runCommand: (text: string) => void;
}

export class EditorOverlays {
  constructor(private readonly ctx: EditorContext, private readonly deps: EditorOverlayDeps) {}

  openCommandPalette(): void {
    const { overlays } = this.ctx;
    if (overlays.isOpen('palette')) return;
    overlays.hideAll(APP_OVERLAYS);
    overlays.showPalette({
      onCommand: (commandName) => {
        overlays.close('palette');
        // Route through the chat-submit pipeline so /quit, /reload, etc.
        // behave the same way as if the user had typed them in the composer.
        this.deps.runCommand(`/${commandName}`);
      },
      onCancel: () => overlays.close('palette'),
    });
  }

  openHotkeys(): void {
    const { overlays } = this.ctx;
    if (overlays.isOpen('hotkeys')) return;
    overlays.hideAll(APP_OVERLAYS);
    overlays.show('hotkeys', new HotkeysOverlay({ onClose: () => overlays.close('hotkeys') }));
  }

  async openMCPServerList(): Promise<void> {
    const { overlays } = this.ctx;
    // A second press while the bridge loads must not open a second list and lose the handle to the first.
    if (overlays.isOpen('mcp') || overlays.loading.has('mcp')) return;
    overlays.loading.add('mcp');
    let bridge: typeof import('@/mcp/bridge');
    try {
      // Lazy import keeps the bridge out of tui-editor module init for tests.
      bridge = await import('@/mcp/bridge');
    } finally {
      overlays.loading.delete('mcp');
    }
    if (this.ctx.exiting() || overlays.isOpen('mcp')) return;
    const { getMCPBridge } = bridge;
    const provider = bridgeProvider(getMCPBridge() as unknown as Parameters<typeof bridgeProvider>[0]);
    overlays.show('mcp', new MCPServerList({ provider, onClose: () => overlays.close('mcp') }));
  }

  async openWorkspacePicker(): Promise<void> {
    const { overlays } = this.ctx;
    // A second press while the list loads must not open a second picker and lose the handle to the first.
    if (overlays.isOpen('workspace') || overlays.loading.has('workspace')) return;
    overlays.loading.add('workspace');
    let error: string | undefined;
    try {
      error = await this.refreshWorkspaces();
    } finally {
      overlays.loading.delete('workspace');
    }
    if (this.ctx.exiting() || overlays.isOpen('workspace')) return;
    const overlay = new WorkspacePicker({
      workspaces: this.deps.workspace,
      error,
      onPick: (slug) => {
        this.deps.workspace.setActive(slug);
        this.deps.adapter.disconnect();
        void this.deps.adapter.connect();
        this.ctx.log(slug ? `Switched workspace to ${slug}.` : 'Reset to default workspace.');
        overlays.close('workspace');
      },
      onCancel: () => overlays.close('workspace'),
    });
    overlays.show('workspace', overlay);
  }

  /** Reload the workspace list; returns why it failed, if it did (the previous list stays). */
  private async refreshWorkspaces(): Promise<string | undefined> {
    const result = await this.deps.apiClient.getJson<{ workspaces?: WorkspaceMeta[] } | WorkspaceMeta[]>('/me/workspaces');
    if (!result.ok) return result.error;
    const list = Array.isArray(result.data) ? result.data : result.data.workspaces ?? [];
    this.deps.workspace.setAvailable(list);
    return undefined;
  }

  openFind(): void {
    const { overlays, tui } = this.ctx;
    if (overlays.isOpen('find')) return;
    const overlay = new FindOverlay({
      buffers: this.ctx.buffers,
      onClose: () => overlays.close('find'),
      onMatches: (bufferId, matches, current) => { this.deps.editor.setSearchHighlights(bufferId, matches, current); tui.requestRender(); },
    });
    overlays.show('find', overlay, SEARCH_OVERLAY);
  }

  openReplace(): void {
    const { overlays, tui } = this.ctx;
    if (overlays.isOpen('replace')) return;
    const overlay = new ReplaceOverlay({
      buffers: this.ctx.buffers,
      onCommit: (count) => {
        this.ctx.log(`Replaced ${count} occurrence${count === 1 ? '' : 's'}.`);
        overlays.close('replace');
        tui.requestRender();
      },
      onClose: () => overlays.close('replace'),
      onMatches: (bufferId, matches, current) => { this.deps.editor.setSearchHighlights(bufferId, matches, current); tui.requestRender(); },
    });
    overlays.show('replace', overlay, SEARCH_OVERLAY);
  }

  /** Search the project's files; `query` starts a search at once. */
  openProjectSearch(query: string): void {
    const { overlays, tui, buffers } = this.ctx;
    if (overlays.isOpen('projectSearch')) return;
    overlays.hideAll(APP_OVERLAYS);
    const overlay = new ProjectSearchOverlay({
      root: this.ctx.projectPath,
      initialQuery: query,
      onClose: () => overlays.close('projectSearch'),
      onUpdate: () => tui.requestRender(),
      onOpen: (hit) => {
        overlays.close('projectSearch');
        this.deps.openFile(hit.path);
        const record = buffers.findByPath(hit.path);
        if (!record) return;
        buffers.setActive(record.id);
        record.buffer.select({ line: hit.line, col: hit.col + hit.length }, { line: hit.line, col: hit.col });
        this.ctx.layout.focus('editor');
        this.ctx.refocus();
        tui.requestRender();
      },
    });
    overlays.show('projectSearch', overlay, PROJECT_SEARCH_OVERLAY);
  }

  openFilePicker(): void {
    const { overlays, tui } = this.ctx;
    if (overlays.isOpen('filePicker')) return;
    const picker = new FilePicker({
      root: this.ctx.projectPath,
      onPick: (path) => {
        overlays.close('filePicker');
        this.deps.openFile(path);
      },
      onCancel: () => overlays.close('filePicker'),
      onUpdate: () => tui.requestRender(),
    });
    overlays.show('filePicker', picker);
  }
}
