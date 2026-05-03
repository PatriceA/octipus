/**
 * <StatusBar> — top one-line strip.
 *
 * Shows: app brand · connection dot · workspace · model · session
 * cost. Matches the layout in `docs/architecture/TUI-EDITOR.md`.
 */
import { Box, Text } from 'ink';
import { agentStore, workspaceStore } from '../app';
import { useStore } from '../stores/use-store';
import { getTheme } from '../theme';

export function StatusBar() {
  const theme = getTheme();
  const status = useStore(agentStore, (s) => s.connectionStatus);
  const last = useStore(agentStore, (s) => s.lastStats);
  const cum = useStore(agentStore, (s) => s.cumulative);
  const wsActive = useStore(workspaceStore, (s) => s.activeSlug);

  const dot =
    status === 'connected' ? <Text color={theme.ok}>●</Text>
    : status === 'connecting' || status === 'authenticating' ? <Text color={theme.warn}>●</Text>
    : <Text color={theme.error}>●</Text>;

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box>
        <Text bold color={theme.accent}>Octipus</Text>
        <Text> </Text>
        {dot}
        <Text color={theme.dim}> · </Text>
        <Text color={theme.statusFg}>{wsActive ?? 'default'}</Text>
      </Box>
      <Box>
        {last.model && (
          <Text color={theme.dim}>{last.model}{' '}</Text>
        )}
        {cum.tokens > 0 && (
          <Text color={theme.dim}>
            {cum.tokens.toLocaleString()} tok
            {cum.cost > 0 ? ` · $${cum.cost.toFixed(4)}` : ''}
          </Text>
        )}
      </Box>
    </Box>
  );
}
