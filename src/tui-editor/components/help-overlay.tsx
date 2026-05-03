/**
 * <HelpOverlay> — Ctrl+P → "Show all keyboard shortcuts".
 *
 * Static reference card; mirrors the table in
 * `docs/architecture/TUI-EDITOR.md`.
 */
import { Box, Text, useInput } from 'ink';
import { commands } from '../commands';
import { getTheme } from '../theme';

interface Props { onClose: () => void; }

export function HelpOverlay({ onClose }: Props) {
  const theme = getTheme();
  useInput((_, key) => { if (key.escape || key.return) onClose(); });

  const withShortcut = commands.filter((c) => c.shortcut);
  return (
    <Box flexDirection="column" borderStyle="double" borderColor={theme.borderFocus} paddingX={1} width={70}>
      <Text bold color={theme.accent}>Keyboard shortcuts</Text>
      <Text> </Text>
      {withShortcut.map((c) => (
        <Box key={c.id}>
          <Box width={20}><Text color={theme.statusFg}>{c.shortcut}</Text></Box>
          <Text color={theme.fg}>{c.title}</Text>
        </Box>
      ))}
      <Text> </Text>
      <Text color={theme.dim}>esc to close</Text>
    </Box>
  );
}
