/**
 * <ModeBar> — bottom one-line strip.
 *
 * Shows the active buffer's filename + cursor position (or the
 * permission prompt when one is active — that takes priority since
 * it blocks input).
 */
import { Box, Text } from 'ink';
import { agentStore, bufferStore, layoutStore } from '../app';
import { useStore } from '../stores/use-store';
import { getTheme } from '../theme';

export function ModeBar() {
  const theme = getTheme();
  const active = useStore(bufferStore, (s) => s.buffers.find((b) => b.id === s.activeId) ?? null);
  const editorMode = useStore(layoutStore, (s) => s.editorMode);
  const pendingPerm = useStore(agentStore, (s) => s.pendingPermission);

  if (pendingPerm) {
    return (
      <Box paddingX={1}>
        <Text color={theme.warn} bold>⚠ Permission: </Text>
        <Text color={theme.fg}>{pendingPerm.detail}</Text>
        <Text color={theme.dim}>  (y/n)</Text>
      </Box>
    );
  }

  if (!active) {
    return (
      <Box paddingX={1}>
        <Text color={theme.dim}>NO BUFFER  Ctrl+O to open · Ctrl+P for command palette</Text>
      </Box>
    );
  }

  const cur = active.buffer.getCursor();
  const dirty = active.dirty ? <Text color={theme.warn}>●</Text> : null;
  // Modeless surfaces "NORMAL" as a static label; vim shows the
  // real vim-mode (NORMAL / INSERT / VISUAL) — but we don't read the
  // vim state from here (it lives in the editor component's ref).
  // For now, vim mode shows "VIM" so the user can see they are in
  // it; the in-editor mode indicator is a future polish slice.
  const modeLabel = editorMode === 'vim' ? 'VIM' : 'NORMAL';
  return (
    <Box paddingX={1}>
      <Text color={theme.accentDim}>{modeLabel} </Text>
      <Text color={theme.fg}>{active.label}</Text>
      <Text color={theme.dim}>:{cur.line + 1}:{cur.col + 1}</Text>
      <Text> </Text>
      {dirty}
      <Text color={theme.dim}>
        {'  '}{active.language}
        {active.agentLocked ? ' · agent-locked' : ''}
        {active.lockMode === 'merge' ? ' · merge' : ''}
      </Text>
    </Box>
  );
}
