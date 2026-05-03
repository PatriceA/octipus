/**
 * <ModeBar> — bottom one-line strip.
 *
 * Shows the active buffer's filename + cursor position (or the
 * permission prompt when one is active — that takes priority since
 * it blocks input).
 */
import { Box, Text } from 'ink';
import { agentStore, bufferStore } from '../app';
import { useStore } from '../stores/use-store';
import { getTheme } from '../theme';

export function ModeBar() {
  const theme = getTheme();
  const active = useStore(bufferStore, (s) => s.buffers.find((b) => b.id === s.activeId) ?? null);
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
  return (
    <Box paddingX={1}>
      <Text color={theme.accentDim}>NORMAL </Text>
      <Text color={theme.fg}>{active.label}</Text>
      <Text color={theme.dim}>:{cur.line + 1}:{cur.col + 1}</Text>
      <Text> </Text>
      {dirty}
      <Text color={theme.dim}>  {active.language}{active.agentLocked ? ' · agent-locked' : ''}</Text>
    </Box>
  );
}
