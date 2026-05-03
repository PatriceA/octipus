/**
 * <CommandPalette> — Ctrl+P overlay.
 *
 * Fuzzy search over `commands.ts`. Arrow keys + enter to dispatch.
 * Esc closes the overlay.
 */
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useState } from 'react';
import type { CommandContext } from '../commands';
import { type Command, commands, fuzzyMatch } from '../commands';
import { getTheme } from '../theme';

interface Props {
  ctx: CommandContext;
  onClose: () => void;
}

export function CommandPalette({ ctx, onClose }: Props) {
  const theme = getTheme();
  const [query, setQuery] = useState('');
  const [idx, setIdx] = useState(0);
  const matches = fuzzyMatch(query, commands).slice(0, 10);

  useInput((_, key) => {
    if (key.escape) { onClose(); return; }
    if (key.upArrow) { setIdx((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIdx((i) => Math.min(matches.length - 1, i + 1)); return; }
    if (key.return) {
      const cmd = matches[idx];
      if (cmd) {
        Promise.resolve(cmd.run(ctx)).finally(onClose);
      } else {
        onClose();
      }
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={theme.borderFocus}
      paddingX={1}
      width={70}
    >
      <Box>
        <Text color={theme.dim}>{'> '}</Text>
        <TextInput
          value={query}
          onChange={(v) => { setQuery(v); setIdx(0); }}
          placeholder="type to search commands…"
        />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {matches.length === 0 ? (
          <Text color={theme.dim}>  no matches</Text>
        ) : matches.map((c: Command, i) => (
          <Box key={c.id}>
            <Text color={i === idx ? theme.accent : theme.fg}>
              {i === idx ? '› ' : '  '}{c.title}
            </Text>
            {c.shortcut && (
              <Text color={theme.dim}>  {c.shortcut}</Text>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
