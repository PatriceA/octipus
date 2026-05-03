/**
 * <GotoLineOverlay> — Ctrl+G overlay that jumps the cursor to a
 * 1-indexed line in the active buffer.
 */
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useState } from 'react';
import { bufferStore } from '../app';
import { getTheme } from '../theme';

interface Props { onClose: () => void; }

export function GotoLineOverlay({ onClose }: Props) {
  const theme = getTheme();
  const [text, setText] = useState('');

  useInput((_, key) => { if (key.escape) onClose(); });

  const submit = (v: string) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) { onClose(); return; }
    const a = bufferStore.active();
    if (a) {
      const line = Math.max(0, Math.min(n - 1, a.buffer.lineCount() - 1));
      a.buffer.setCursor({ line, col: 0 });
    }
    onClose();
  };

  return (
    <Box borderStyle="double" borderColor={theme.borderFocus} paddingX={1} width={40}>
      <Text color={theme.dim}>line: </Text>
      <TextInput value={text} onChange={setText} onSubmit={submit} />
    </Box>
  );
}
