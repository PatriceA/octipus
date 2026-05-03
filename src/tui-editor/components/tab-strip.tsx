/**
 * <TabStrip> — bottom bar of the editor pane listing open buffers.
 *
 * Active buffer highlighted; dirty buffers get a `●`. Cycling
 * happens via Ctrl+Tab / Ctrl+Shift+Tab on the layout root.
 */
import { Box, Text } from 'ink';
import { bufferStore } from '../app';
import { useStore } from '../stores/use-store';
import { getTheme } from '../theme';

export function TabStrip() {
  const theme = getTheme();
  const buffers = useStore(bufferStore, (s) => s.buffers);
  const activeId = useStore(bufferStore, (s) => s.activeId);

  if (buffers.length === 0) return null;

  return (
    <Box>
      {buffers.map((b, i) => (
        <Box key={b.id} marginRight={2}>
          <Text color={b.id === activeId ? theme.accent : theme.dim}>
            {i + 1} {b.label}
            {b.dirty ? ' ●' : ''}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
