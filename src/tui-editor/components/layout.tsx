/**
 * <Layout> — three-pane root. Routes the global keymap.
 *
 * Left  : file tree (toggle Ctrl+B)
 * Center: editor + tab strip
 * Right : chat (toggle Ctrl+J)
 *
 * Global shortcuts dispatched here so they win over pane-specific
 * input. Pane-local shortcuts (cursor motion, chat submit) live in
 * the pane components themselves and only fire when the pane is
 * focused.
 */
import { Box, useApp, useInput } from 'ink';
import type { GatewayClient } from '../../tui/gateway-client';
import { agentStore, bufferStore, layoutStore, workspaceStore } from '../app';
import { useStore } from '../stores/use-store';
import { ChatPane } from './chat-pane';
import { CommandPalette } from './command-palette';
import { FilePickerOverlay } from './file-picker';
import { FileTree } from './file-tree';
import { FindOverlay } from './find-overlay';
import { GotoLineOverlay } from './goto-line';
import { HelpOverlay } from './help-overlay';
import { ModeBar } from './mode-bar';
import { Pane } from './pane';
import { ReplaceOverlay } from './replace-overlay';
import { StatusBar } from './status-bar';
import { TabStrip } from './tab-strip';
import { TextEditor } from './text-editor';
import { WorkspacePickerOverlay } from './workspace-picker';

interface Props {
  client: GatewayClient;
  sessionId: string;
}

export function Layout({ client, sessionId }: Props) {
  const { exit } = useApp();
  const layout = useStore(layoutStore);

  useInput((input, key) => {
    // Overlay always takes priority; let it handle its own keys.
    if (layout.overlay) return;

    if (key.ctrl && input === 'p') { layoutStore.openOverlay({ kind: 'palette' }); return; }
    if (key.ctrl && input === 'o') { layoutStore.openOverlay({ kind: 'file-picker' }); return; }
    if (key.ctrl && input === 'b') { layoutStore.toggleTree(); return; }
    if (key.ctrl && input === 'j') { layoutStore.toggleChat(); return; }
    if (key.ctrl && input === '\\') { layoutStore.cycleFocus(1); return; }
    if (key.ctrl && input === 'k') { agentStore.clearMessages(); return; }
    if (key.ctrl && input === 'w') {
      const a = bufferStore.active();
      if (a) bufferStore.close(a.id);
      return;
    }
    if (key.tab && key.ctrl) { bufferStore.cycle(key.shift ? -1 : 1); return; }
    if (key.ctrl && input === 'c') { client.disconnect(); exit(); }
  });

  const ctx = { layout: layoutStore, buffers: bufferStore, agent: agentStore, workspace: workspaceStore };
  const renderOverlay = () => {
    const o = layout.overlay;
    if (!o) return null;
    const close = () => layoutStore.closeOverlay();
    switch (o.kind) {
      case 'palette': return <CommandPalette ctx={ctx} onClose={close} />;
      case 'file-picker': return <FilePickerOverlay onClose={close} />;
      case 'workspace-picker': return <WorkspacePickerOverlay onClose={close} />;
      case 'goto-line': return <GotoLineOverlay onClose={close} />;
      case 'find': return <FindOverlay onClose={close} />;
      case 'replace': return <ReplaceOverlay onClose={close} />;
      case 'help': return <HelpOverlay onClose={close} />;
    }
  };

  // Approximate editor height: total rows minus status (1) + mode (1) + tab strip (1) + borders.
  const editorHeight = Math.max(5, layout.rows - 6);

  return (
    <Box flexDirection="column" height="100%">
      <StatusBar />
      <Box flexGrow={1}>
        {layout.treeVisible && (
          <Pane title="files" focused={layout.focused === 'tree'} width={28}>
            <FileTree focused={layout.focused === 'tree'} />
          </Pane>
        )}
        <Pane title="editor" focused={layout.focused === 'editor'} flexGrow={1}>
          <TextEditor focused={layout.focused === 'editor'} height={editorHeight} />
          <TabStrip />
        </Pane>
        {layout.chatVisible && (
          <Pane title="chat" focused={layout.focused === 'chat'} width={42}>
            <ChatPane client={client} sessionId={sessionId} focused={layout.focused === 'chat'} />
          </Pane>
        )}
      </Box>
      <ModeBar />
      {layout.overlay && (
        <Box position="absolute" marginTop={2} marginLeft={4}>
          {renderOverlay()}
        </Box>
      )}
    </Box>
  );
}
